import type { Request, Response, NextFunction } from "express";
import type { ZodType } from "zod";

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "validation_error",
        details: result.error.flatten(),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
