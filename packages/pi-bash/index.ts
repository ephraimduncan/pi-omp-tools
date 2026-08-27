/**
 * pi-bash: registers the `bash` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerBash, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerBash(pi);
}
