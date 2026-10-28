import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { LogContext } from "../../platform/application/log-context";
import { CreateWallet, type WalletView } from "../application/create-wallet";
import { GetWallet } from "../application/get-wallet";
import { parseCreateWallet, parseWalletId } from "./wallet-http.schemas";

@Controller("wallets")
export class WalletController {
	constructor(
		private readonly createWallet: CreateWallet,
		private readonly getWallet: GetWallet,
	) {}

	@Post()
	@HttpCode(201)
	create(@Body() body: unknown): Promise<WalletView> {
		const input = parseCreateWallet(body);
		return this.createWallet.execute({
			playerId: input.playerId,
			initialBalance: input.initialBalance,
			// Always present behind CorrelationIdMiddleware; the fallback only keeps the type honest.
			correlationId: LogContext.current().correlationId ?? "unknown",
		});
	}

	@Get(":walletId")
	get(@Param("walletId") walletId: string): Promise<WalletView> {
		const id = parseWalletId(walletId);
		LogContext.setWalletId(id);
		return this.getWallet.execute(id);
	}
}
