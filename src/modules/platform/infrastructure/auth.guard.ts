import {
	type CanActivate,
	type ExecutionContext,
	Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator";

/**
 * Global guard (ADR-0017). `@Public()` routes (health, metrics) skip it; for everything else the
 * decision lives in `authenticate`, which is a no-op here and the single place a real
 * implementation (JWT via JWKS, 403 on `providerId` mismatch) replaces.
 */
@Injectable()
export class AuthGuard implements CanActivate {
	constructor(private readonly reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
			IS_PUBLIC_KEY,
			[context.getHandler(), context.getClass()],
		);
		return isPublic === true || this.authenticate(context);
	}

	protected authenticate(_context: ExecutionContext): boolean {
		return true;
	}
}
