import { Router, Request, Response } from 'express';
import { fetchGoogleSheetsRange, GoogleSheetsRequestError } from '../integrations/googleSheets';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const result = await fetchGoogleSheetsRange(req.body ?? {});
    res.json(result);
  } catch (error) {
    const statusCode = error instanceof GoogleSheetsRequestError ? error.statusCode : 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to import Google Sheets data',
    });
  }
});

export default router;
