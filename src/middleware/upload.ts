import type { RequestHandler } from 'express';
import multer from 'multer';
import type { Config } from '../config/env';
import { AppError } from '../lib/errors';

/** Single-file multipart parser held in memory. The file is validated by magic bytes in the service, not here. */
export function createUpload(config: Config): (fileField: string) => RequestHandler {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 20, fieldSize: 10_000 },
  });
  return (fileField) => (req, res, next) => {
    parser.single(fileField)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const mb = Math.round(config.uploads.maxBytes / (1024 * 1024));
          return next(new AppError(413, 'FILE_TOO_LARGE', `The file is larger than ${mb} MB`));
        }
        return next(new AppError(400, 'INVALID_UPLOAD', err.message));
      }
      next(err);
    });
  };
}
