/**
 * pi-browser: registers the `browser` tool from @ephraimduncan/omp-tools-core.
 */
import { registerBrowser, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerBrowser(pi);
}
