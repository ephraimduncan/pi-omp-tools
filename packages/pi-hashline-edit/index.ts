/**
 * pi-hashline-edit: registers the `edit` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerEdit, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerEdit(pi);
}
