import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { uploadMaxMb } from '../config/operational';

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
    else cb(new Error('Only PDF files are allowed'));
  },
});

/** The PDF size cap this process enforces, in MB. Served to the browser by GET /api/auth/me. */
export function pdfUploadLimitMb(): number {
  return LIMIT_MB;
}

/**
 * Middleware accepting one PDF in `field`, into `req.file.buffer`.
 *
 * A file over the cap answers 413 with the limit in the message. multer's own
 * error says only "File too large", and that reached the generic handler as a
 * 500 - which told the person neither that the size was the problem nor what
 * size would do. Every other multer error goes on to the error handlers as
 * before.
 */
export function pdfUpload(field: string): RequestHandler {
  const single = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    single(req, res, (error?: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error:
            `That PDF is larger than ${LIMIT_MB} MB, the most this server accepts. ` +
            'Upload a smaller file, or ask the administrator to raise UPLOAD_MAX_MB.',
          code: 'upload-too-large',
          limitMb: LIMIT_MB,
        });
        return;
      }
      next(error as Error | undefined);
    });
  };
}
