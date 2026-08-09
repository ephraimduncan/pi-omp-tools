/**
 * pi-search: registers the `search` tool from @ephraimduncan/omp-tools-core.
 */
import { registerSearch, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerSearch(pi);
}
