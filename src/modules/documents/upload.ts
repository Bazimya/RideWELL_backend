import multer from 'multer';
import type { RequestHandler } from 'express';
import { badRequest } from '../../lib/errors.js';
import { MAX_UPLOAD_BYTES } from './fileInspection.js';

/**
 * One file per request, held in memory (max 5 MB), never written to a public
 * folder. The content is inspected and cleaned before it reaches storage.
 */
const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 1024, parts: 7 },
}).single('file');

export const singleUpload: RequestHandler = (req, res, next) => {
  parser(req, res, (err: unknown) => {
    if (!err) {
      if (!req.file) return next(badRequest('file_required', 'Choose a file to upload.'));
      return next();
    }
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') return next(badRequest('file_too_large', 'Files must be 5 MB or smaller.'));
    if (code?.startsWith('LIMIT_')) return next(badRequest('invalid_upload', 'Upload one file at a time.'));
    next(badRequest('invalid_upload', 'The upload could not be read.'));
  });
};
