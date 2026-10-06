import { z } from 'zod';
import { meSchema } from '../../lib/dto';
import { onboardingPayloadSchema } from '../onboarding/onboarding.schemas';

export const emailSchema = z
  .email()
  .max(254)
  .transform((e) => e.trim().toLowerCase());
export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(128);

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** When present, the profile, goal, plan and commitment are saved in the same transaction as the account. */
  onboarding: onboardingPayloadSchema.optional(),
});

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const oauthBodySchema = z.object({
  idToken: z.string().min(10),
  /** If the client passed a nonce when starting the sign-in, send it here so it can be checked. */
  nonce: z.string().max(256).optional(),
  onboarding: onboardingPayloadSchema.optional(),
});

export const refreshBodySchema = z.object({ refreshToken: z.string().min(20).max(200) });
export const forgotBodySchema = z.object({ email: emailSchema });
export const resetBodySchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  /** Access token lifetime in seconds. */
  expiresIn: z.number().int(),
});
export type Tokens = z.infer<typeof tokensSchema>;

export const authResponseSchema = z.object({ user: meSchema, tokens: tokensSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const statusSchema = z.object({ status: z.literal('ok') });
