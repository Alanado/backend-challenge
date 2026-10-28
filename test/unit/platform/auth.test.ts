import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "../../../src/modules/platform/infrastructure/auth.guard";
import { NoopProviderIdentity } from "../../../src/modules/platform/infrastructure/noop-provider-identity";
import {
	IS_PUBLIC_KEY,
	Public,
} from "../../../src/modules/platform/infrastructure/public.decorator";

class Sample {
	@Public()
	open(): void {}

	closed(): void {}
}

@Public()
class OpenController {
	anything(): void {}
}

function contextFor(
	controller: new () => object,
	handler: () => void,
): ExecutionContext {
	return {
		getHandler: () => handler,
		getClass: () => controller,
	} as unknown as ExecutionContext;
}

describe("T-054 AuthGuard (no-op)", () => {
	const guard = new AuthGuard(new Reflector());

	test("T-054 always lets the request through", () => {
		expect(guard.canActivate(contextFor(Sample, Sample.prototype.closed))).toBe(
			true,
		);
		expect(guard.canActivate(contextFor(Sample, Sample.prototype.open))).toBe(
			true,
		);
	});

	test("T-054 @Public marks a handler and a whole controller", () => {
		const reflector = new Reflector();
		expect(reflector.get(IS_PUBLIC_KEY, Sample.prototype.open)).toBe(true);
		expect(
			reflector.get(IS_PUBLIC_KEY, Sample.prototype.closed),
		).toBeUndefined();
		expect(reflector.get(IS_PUBLIC_KEY, OpenController)).toBe(true);
	});
});

describe("T-054 NoopProviderIdentity", () => {
	const identity = new NoopProviderIdentity();

	test("T-054 asserts no identity when there is no credential", () => {
		expect(identity.resolveProvider({ headers: {} })).toEqual({
			authenticated: false,
			providerId: undefined,
		});
	});

	test("T-054 ignores every X-* header: they are client-controlled, not credentials", () => {
		const resolved = identity.resolveProvider({
			headers: {
				"x-provider-id": "evil-provider",
				"x-forwarded-user": "admin",
				"x-correlation-id": "abc",
				"x-api-key": "secret",
				authorization: "Bearer not-checked",
			},
		});
		expect(resolved).toEqual({ authenticated: false, providerId: undefined });
	});
});
