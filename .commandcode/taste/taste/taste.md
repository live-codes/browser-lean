# Taste
- Prefers starting with a minimal proof-of-concept (e.g. a single simple HTML page) to validate an approach before building out full integration. Confidence: 0.6
- When the user surfaces an existing reference implementation, expects it to be evaluated hands-on and adopted if it performs better (faster load, smaller payload) rather than dismissed from a README or surface impression. Confidence: 0.5
- Probes feature claims skeptically — asks whether capabilities advertised upstream are actually supported in the current port, whether they are enabled by default, and whether they ship in the same bundle or are lazy-loaded (i.e. cares about payload cost and eager-vs-lazy loading). Confidence: 0.4
- Wants upstream feature parity: when the port lacks a capability that upstream advertises, expects it to be implemented rather than documented as an unsupported limitation ("we should support them"). Confidence: 0.5
- Challenges hardcoded limits / magic numbers (e.g. a fixed retry cap, "what happens if we have more than 4 imports?") and expects behavior bounded by real progress or logic rather than an arbitrary count. Confidence: 0.5
- Favors client-side / serverless solutions — code should run entirely in the browser with no server-side compilation or upload. Confidence: 0.6
