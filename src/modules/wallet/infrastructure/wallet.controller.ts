import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	Query,
} from "@nestjs/common";
import { LogContext } from "../../platform/application/log-context";
import { CreateWallet, type WalletView } from "../application/create-wallet";
import { GetWallet } from "../application/get-wallet";
import {
	type LedgerPageView,
	ListWalletLedger,
} from "../application/list-wallet-ledger";
import {
	ReconcileWallet,
	type ReconciliationView,
} from "../application/reconcile-wallet";
import {
	parseCreateWallet,
	parseLedgerQuery,
	parseWalletId,
} from "./wallet-http.schemas";

@Controller("wallets")
export class WalletController {
	constructor(
		private readonly createWallet: CreateWallet,
		private readonly getWallet: GetWallet,
		private readonly listLedger: ListWalletLedger,
		private readonly reconcileWallet: ReconcileWallet,
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

	@Get(":walletId/ledger")
	ledger(
		@Param("walletId") walletId: string,
		@Query() query: unknown,
	): Promise<LedgerPageView> {
		const id = parseWalletId(walletId);
		LogContext.setWalletId(id);
		return this.listLedger.execute(id, parseLedgerQuery(query));
	}

	/** Always 200: a divergence is the answer (`consistent: false`), not an error. */
	@Post(":walletId/reconciliation")
	@HttpCode(200)
	reconcile(@Param("walletId") walletId: string): Promise<ReconciliationView> {
		const id = parseWalletId(walletId);
		LogContext.setWalletId(id);
		return this.reconcileWallet.execute(id);
	}
}
