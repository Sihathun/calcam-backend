import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { AppDeps } from '../../deps';
import { AppError, conflict, notFound, unauthorized } from '../../lib/errors';
import { loadMe } from '../../lib/me';
import type { OAuthProvider } from '../../lib/oauth';
import type { OnboardingService, PreparedOnboarding } from '../onboarding/onboarding.service';
import type { OnboardingPayload } from '../onboarding/onboarding.schemas';
import type { AuthResponse, Tokens } from './auth.schemas';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ClientInfo {
  /** Reserved for audit logging. Never stored with a refresh token today. */
  ip?: string;
}

export function createAuthService(deps: AppDeps, onboarding: OnboardingService) {
  const { config, prisma, clock } = deps;

  // Verified against when the email is unknown, so login timing does not reveal which emails exist.
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () => (dummyHash ??= argon2.hash('not-a-real-password'));

  async function issueTokens(userId: string, familyId: string = randomUUID()): Promise<Tokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(clock().getTime() + config.auth.refreshTtlDays * 86_400_000);
    await prisma.refreshToken.create({ data: { userId, tokenHash: sha256(refreshToken), familyId, expiresAt } });
    const accessToken = jwt.sign({}, config.auth.accessSecret, {
      algorithm: 'HS256',
      subject: userId,
      expiresIn: config.auth.accessTtlSeconds,
      jwtid: randomUUID(),
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: config.auth.accessTtlSeconds };
  }

  async function respond(userId: string): Promise<AuthResponse> {
    const [tokens, user] = await Promise.all([issueTokens(userId), loadMe(prisma, userId)]);
    return { user, tokens };
  }

  async function createUserWithOnboarding(
    data: Prisma.UserCreateInput,
    prep: PreparedOnboarding | undefined,
  ): Promise<User> {
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data });
        if (prep) await onboarding.apply(tx, user.id, prep);
        return user;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('ACCOUNT_EXISTS', 'An account with these details already exists');
      }
      throw err;
    }
  }

  async function revokeFamily(db: Pick<PrismaClient, 'refreshToken'>, familyId: string) {
    await db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: clock() } });
  }

  return {
    async register(input: { email: string; password: string; onboarding?: OnboardingPayload }): Promise<AuthResponse> {
      // Validate and calculate first, so a 422 never leaves a half-created account behind.
      const prep = input.onboarding ? onboarding.prepare(input.onboarding) : undefined;
      if (await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      }
      const passwordHash = await argon2.hash(input.password);
      const user = await createUserWithOnboarding({ email: input.email, passwordHash }, prep);
      return respond(user.id);
    },

    async login(input: { email: string; password: string }): Promise<AuthResponse> {
      const user = await prisma.user.findFirst({ where: { email: input.email, deletedAt: null } });
      const hash = user?.passwordHash ?? (await getDummyHash());
      const ok = await argon2.verify(hash, input.password).catch(() => false);
      if (!user || !user.passwordHash || !ok) {
        throw unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password');
      }
      return respond(user.id);
    },

    async oauth(
      provider: OAuthProvider,
      input: { idToken: string; nonce?: string; onboarding?: OnboardingPayload },
    ): Promise<AuthResponse> {
      const identity = await deps.oauth.verify(provider, input.idToken, input.nonce);
      const subField = provider === 'apple' ? 'appleSub' : 'googleSub';

      let user = await prisma.user.findFirst({ where: { [subField]: identity.sub, deletedAt: null } });

      // Link to an existing account only when the provider vouches for the email address.
      if (!user && identity.email && identity.emailVerified) {
        const byEmail = await prisma.user.findFirst({ where: { email: identity.email, deletedAt: null } });
        if (byEmail) user = await prisma.user.update({ where: { id: byEmail.id }, data: { [subField]: identity.sub } });
      }

      const prep = input.onboarding ? onboarding.prepare(input.onboarding) : undefined;
      if (!user) {
        user = await createUserWithOnboarding(
          { [subField]: identity.sub, email: identity.emailVerified ? (identity.email ?? null) : null },
          prep,
        );
      } else if (prep && !(await prisma.profile.findUnique({ where: { userId: user.id } }))) {
        const existing = user;
        await prisma.$transaction((tx) => onboarding.apply(tx, existing.id, prep));
      }
      return respond(user.id);
    },

    /** Rotates the refresh token. Presenting a token that was already rotated revokes the whole family. */
    async refresh(refreshToken: string): Promise<AuthResponse> {
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
      if (!row) throw unauthorized('INVALID_REFRESH_TOKEN', 'The refresh token is invalid');

      if (row.revokedAt) {
        await revokeFamily(prisma, row.familyId);
        throw unauthorized('REFRESH_TOKEN_REUSED', 'The refresh token was already used. Please sign in again.');
      }
      if (row.expiresAt <= clock()) throw unauthorized('INVALID_REFRESH_TOKEN', 'The refresh token has expired');

      // Atomic claim: if two requests race with the same token, exactly one wins and the other is treated as reuse.
      const claimed = await prisma.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: clock() },
      });
      if (claimed.count === 0) {
        await revokeFamily(prisma, row.familyId);
        throw unauthorized('REFRESH_TOKEN_REUSED', 'The refresh token was already used. Please sign in again.');
      }

      const user = await prisma.user.findFirst({ where: { id: row.userId, deletedAt: null }, select: { id: true } });
      if (!user) throw unauthorized('INVALID_REFRESH_TOKEN', 'The refresh token is invalid');

      const [tokens, me] = await Promise.all([issueTokens(user.id, row.familyId), loadMe(prisma, user.id)]);
      return { user: me, tokens };
    },

    /** Idempotent: an unknown or already revoked token is not an error. */
    async logout(refreshToken: string): Promise<void> {
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
      if (row) await revokeFamily(prisma, row.familyId);
    },

    async forgotPassword(email: string): Promise<void> {
      if (!config.auth.passwordResetEnabled) throw notFound('FEATURE_DISABLED', 'Password reset is not enabled');
      const user = await prisma.user.findFirst({
        where: { email, deletedAt: null, passwordHash: { not: null } },
        select: { id: true, email: true },
      });
      // Always succeed from the caller's point of view, so the endpoint cannot be used to probe for accounts.
      if (!user?.email) return;

      const token = randomBytes(32).toString('base64url');
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(clock().getTime() + config.auth.passwordResetTtlMinutes * 60_000),
        },
      });
      const link = `${config.mail.resetUrl}${config.mail.resetUrl.includes('?') ? '&' : '?'}token=${token}`;
      await deps.mailer.send({
        to: user.email,
        subject: `Reset your ${config.appName} password`,
        text: `Use this link to choose a new password. It expires in ${config.auth.passwordResetTtlMinutes} minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    },

    async resetPassword(token: string, password: string): Promise<void> {
      if (!config.auth.passwordResetEnabled) throw new AppError(404, 'FEATURE_DISABLED', 'Password reset is not enabled');
      const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
      if (!row || row.usedAt || row.expiresAt <= clock()) {
        throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
      }
      const passwordHash = await argon2.hash(password);
      const claimed = await prisma.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: clock() },
      });
      if (claimed.count === 0) throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
      await prisma.$transaction([
        prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
        // Every device must sign in again with the new password.
        prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: clock() } }),
      ]);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
