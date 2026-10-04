import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { uploadMaxMb } from '../config/operational';
import { PublicError } from './publicError';

/**
 * Taking one PDF out of a multipart request: a resume to build a profile from,
 * or a template to extract.
 *
 * Both uploads used to configure their own multer with their own `10 * 1024 *
 * 1024`, and the profile one wrote every file to `backend/uploads` only to read
 * it straight back into a buffer and delete it. Now there is one instance, held
 * in memory - the handlers only ever wanted the bytes - and so no upload
 * directory for anybody to configure, fill or clean up.
 *
 * The cap is UPLOAD_MAX_MB, read ONCE when this module loads: it sizes the
 * multer instance, which is built once, and every reader of the number below
 * (the 413, GET /api/auth/me) must report the limit that instance actually
 * enforces rather than a fresher read of the environment.
 */
const LIMIT_MB = uploadMaxMb();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMIT_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    // Public and a 415: it is the file the caller chose. As a plain Error it
    // reached the generic handler and answered 500, as though the server broke.
    else cb(new PublicError('Only PDF files can be uploaded.', { status: 415, code: 'upload-not-pdf' }));
  },
});

/** The PDF size cap this process enforces, in MB. Served to the browser by GET /api/auth/me. */
export function pdfUploadLimitMb(): number {
  return LIMIT_MB;
}

/**
 * Middleware accepting one PDF in `field`, into `req.file.buffer`.
 *
 * A file at or over the cap answers 413 with the limit in the message. multer's
 * own error says only "File too large", and that reached the generic handler as
 * a 500 - which told the person neither that the size was the problem nor what
 * size would do. Any other multer refusal is the form's, and goes on to the
 * error handler as a public 400; a non-PDF is the file filter's public 415.
 *
 * AT or over: busboy raises the limit as soon as a file reaches `fileSize`, so a
 * file of exactly LIMIT_MB is refused, as it always was. The wording says so,
 * and from "this server accepts" on it is the upload pages' own pre-check
 * sentence (frontend/src/lib/upload.ts), so either refusal finds the same
 * README row.
 */
export function pdfUpload(field: string): RequestHandler {
  const single = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    single(req, res, (error?: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        // The number, never the setting: the uploader can act on the size, and
        // the variable that raises it is the administrator's.
        res.status(413).json({
          error:
            `That PDF is ${LIMIT_MB} MB or larger; this server accepts PDFs under ${LIMIT_MB} MB. ` +
            'Upload a smaller file, or ask your administrator about larger files.',
          code: 'upload-too-large',
          limitMb: LIMIT_MB,
        });
        return;
      }
      if (error instanceof multer.MulterError) {
        // The form itself was wrong - a second file, a field this route does
        // not take. The caller's to fix, so a 400; multer's own wording names
        // its internals and is the administrator's detail.
        next(
          new PublicError('That upload could not be read. Choose one PDF file and try again.', {
            status: 400,
            code: 'upload-unreadable',
            detail: `${error.code}: ${error.message}`,
          })
        );
        return;
      }
      next(error as Error | undefined);
    });
  };
}
