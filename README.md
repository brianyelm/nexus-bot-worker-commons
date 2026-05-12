# nexus-bot-worker-commons

Shared Cloudflare Worker scaffolding for every Nexus-side bot worker (robert, dexter, maxwell, courtney, jacob, moxie, wren). Workers globals only; zero runtime deps.

See SPEC.md for the full API contract and migration plan.

## Consume in a new bot worker

```powershell
cd C:Users	ragiots<bot>-worker
npm install file:../nexus-bot-worker-commons
```

Then in your worker entry:

```javascript
import { handleChatMessage, makeShouldRespond } from "nexus-bot-worker-commons";

const config = {
  botName: "<bot>",
  persona: { systemPrompt, displayName: "<Bot Name>" },
  tools: { definitions, handlers },
  commands,
  nexusKeyEnvVar: "<BOT>_NEXUS_KEY",
  triggers: { ambient: makeShouldRespond("<bot>", ["<alias>"]) },
  approvalSlug: "<bot>-approvals",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/internal/chat-message") {
      return handleChatMessage(req, env, ctx, config);
    }
    return new Response("not found", { status: 404 });
  }
};
```

Apply the migrations once per D1 DB:

```powershell
npx wrangler d1 execute <bot>-worker-state --file=node_modules/nexus-bot-worker-commons/migrations/001_chat_history.sql --remote
npx wrangler d1 execute <bot>-worker-state --file=node_modules/nexus-bot-worker-commons/migrations/002_memory_facts.sql --remote
npx wrangler d1 execute <bot>-worker-state --file=node_modules/nexus-bot-worker-commons/migrations/003_hitl_pending.sql --remote
```
