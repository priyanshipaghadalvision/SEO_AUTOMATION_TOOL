import { z } from "zod";

// 12 chars with no composition rules: length is a far stronger defence than
// forcing symbols, and arbitrary complexity rules push people toward
// predictable substitutions.
const password = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200, "Password must be at most 200 characters");

export const registerSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(320),
  password,
  name: z.string().trim().max(120).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(320),
  // Not length-validated: an existing password must still be accepted even
  // if the rules tighten later, and rejecting on length here would leak
  // which accounts predate a policy change.
  password: z.string().min(1, "Password is required").max(200),
});
