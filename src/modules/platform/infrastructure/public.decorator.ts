import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Marks a handler or controller as reachable without authentication (health, metrics). */
export const Public = (): MethodDecorator & ClassDecorator =>
	SetMetadata(IS_PUBLIC_KEY, true);
