/**
 * pi-inspect-image: registers the `inspect_image` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerInspectImage, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerInspectImage(pi);
}
