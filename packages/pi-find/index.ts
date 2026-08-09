/**
 * pi-find: registers the `find` tool from @ephraimduncan/omp-tools-core.
 */
import { registerFind, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerFind(pi);
}
