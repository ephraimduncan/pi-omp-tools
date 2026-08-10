/**
 * pi-web-search: registers the `web_search` tool from @ephraimduncan/omp-tools-core.
 */
import { registerWebSearch, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerWebSearch(pi);
}
