import { Injectable } from "@nestjs/common";
import {
	type IdentityRequest,
	type ProviderIdentity,
	ProviderIdentityPort,
} from "../application/provider-identity";

/**
 * ADR-0017: no authentication. It asserts nothing — and in particular never reads `X-*` or
 * `Authorization` headers, which any client can forge. The production design (OIDC client
 * credentials, `azp` → `providerId`) replaces this class, not its callers.
 */
@Injectable()
export class NoopProviderIdentity extends ProviderIdentityPort {
	resolveProvider(_request: IdentityRequest): ProviderIdentity {
		return { authenticated: false, providerId: undefined };
	}
}
