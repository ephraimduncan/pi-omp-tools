/**
 * pi-bash: registers the `bash` tool from @ephraimduncan/omp-tools-core.
 */
import { registerBash, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerBash(pi);
}
