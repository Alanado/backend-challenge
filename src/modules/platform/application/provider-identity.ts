/** Transport-neutral view of a request: all identity resolution needs is the headers. */
export interface IdentityRequest {
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Who is calling. Minimal on purpose (ADR-0017): the production design maps the token's `azp`
 * (or a custom claim) to `providerId` and the guard compares it with the `providerId` of the
 * body, answering 403 on a mismatch. Without authentication nothing is asserted.
 */
export interface ProviderIdentity {
	/** True only when a credential was verified. The no-op implementation never sets it. */
	readonly authenticated: boolean;
	/** The provider the credential belongs to; `undefined` when none was asserted. */
	readonly providerId: string | undefined;
}

/** Extension point for authentication (ADR-0017, RF-AUT-01). */
export abstract class ProviderIdentityPort {
	abstract resolveProvider(request: IdentityRequest): ProviderIdentity;
}
