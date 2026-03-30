import { createTransformer, PROVIDERS } from "./lib/transformers/index.js";

console.log("Building Bulletproof skills for all providers...\n");

let totalSkills = 0;

for (const providerConfig of PROVIDERS) {
	const transformer = createTransformer(providerConfig);
	const count = transformer.build();
	console.log(`  ✓ ${transformer.displayName}: ${count} skills`);
	totalSkills += count;
}

console.log(`\nDone. ${totalSkills} total skill files generated.`);
