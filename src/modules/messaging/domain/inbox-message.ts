import { InvalidInboxStateError } from "./errors";

export interface InboxMessageState {
	messageId: string;
	consumerName: string;
	payloadHash: string;
	receivedAt: Date;
	processedAt: Date | undefined;
}

export interface ReceiveInboxProps {
	messageId: string;
	consumerName: string;
	payloadHash: string;
	now: Date;
}

export class InboxMessage {
	private constructor(
		public readonly messageId: string,
		public readonly consumerName: string,
		public readonly payloadHash: string,
		public readonly receivedAt: Date,
		private _processedAt: Date | undefined,
	) {}

	static receive(props: ReceiveInboxProps): InboxMessage {
		return new InboxMessage(
			props.messageId,
			props.consumerName,
			props.payloadHash,
			props.now,
			undefined,
		);
	}

	/** Rebuilds persisted state; does not revalidate. */
	static rehydrate(state: InboxMessageState): InboxMessage {
		return new InboxMessage(
			state.messageId,
			state.consumerName,
			state.payloadHash,
			state.receivedAt,
			state.processedAt,
		);
	}

	get processedAt(): Date | undefined {
		return this._processedAt;
	}

	isProcessed(): boolean {
		return this._processedAt !== undefined;
	}

	markProcessed(at: Date): void {
		if (this.isProcessed()) {
			throw new InvalidInboxStateError("inbox message was already processed");
		}
		this._processedAt = at;
	}
}
