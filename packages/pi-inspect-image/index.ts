/**
 * pi-inspect-image: registers the `inspect_image` tool from @ephraimduncan/omp-tools-core.
 */
import { registerInspectImage, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerInspectImage(pi);
}
