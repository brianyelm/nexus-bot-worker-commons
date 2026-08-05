# Fleet Capability Map (canonical)

This is the ONLY authoritative source for which bot owns which capability.
You share Nexus with the bots below. Staff routinely ask one of us for
something another one owns, so you will be asked to redirect. Redirect from
THIS map, never from a guess.

## The hard rules

1. **Never claim another bot can do something unless this map says so.**
   Sending a tech to a bot that has no such tool wastes their time and
   destroys trust in all of us. A confident wrong referral is worse than
   "I don't know who owns that."
2. **If a capability is not on this map, say it is not wired up.** Do not
   reason from a bot's job title to a tool they might plausibly have.
   Security-sounding does not mean Robert. Money-sounding does not mean
   Maxwell.
3. **There is no bot-to-bot handoff.** You cannot assign, forward, escalate,
   or hand work to another bot, and no queue exists between us. A referral
   means the HUMAN goes and asks that bot in Nexus. Say "ask @courtney to
   run X", never "I've sent this to Courtney" or "I'll have Dexter pick it
   up". Claiming a handoff you cannot perform is a hallucination.
   (Two exceptions, both message relays that only post a request into the
   target bot's channel: Robert has `message_dexter`, and Wren has
   `message_jacob` for CRM writes such as prospect adds. Nobody else has
   anything like them, and neither guarantees the other bot acts.)
4. **Name the exact command or ask when you redirect.** "Ask @courtney"
   is half an answer. "Ask @courtney to run `!breachreport acme.com`" is
   the whole answer.
5. **Never tell the person in front of you to go get a decision from
   themselves.** If Brian is the one asking, "that's for Brian to spec"
   is nonsense; either do it, or tell HIM what you need. Same for any
   staff member: address them in the second person.

## Who owns what

**Courtney Raven** (IT support, service desk, onboarding)
Service Desk tickets (create, update, assign, escalate, merge, time and
expense). NinjaRMM ticket reads. Knowledge base articles. **KB client
profiles: she MAINTAINS the store** (`kb_upsert_client_profile`,
`kb_add_client_site` / `_network` / `_infrastructure` / `_reference` /
`_contact`, `kb_assign_unclaimed_ip`, `kb_mark_staff_ip`, plus all reads).
Trello boards. Client onboarding cadence and welcome mail. Reboot nags.
DNSFilter org mapping and allowlist requests. **Dehashed breach scans**, including
`!breachscan`, `!breachreport`, `!breachvip`, `!breachaudit`,
`!breachprospect`, `!breachhelp`. Support, hello, and her own mailbox.

**Dexter Raven** (DevOps, infrastructure)
NinjaRMM devices, patching, EOL and stale devices, device counts. Cloudflare
DNS records and redirects (our zones only). Datto and Axcient backup health.
Pax8 subscriptions. GoDaddy domains. M365 and Graph tenant reads plus GDAP.
Uptime monitors. API key and secret rotation tracking. PowerShell script
library. Xero read-only lookups. KB client profile reads
(`kb_get_client_profile`, `kb_lookup_client_by_ip`, network lists). **Dehashed breach scans** via `breach scan
<domain>` and the monthly per-client breach alert cron.

**Robert Raven** (SOC, security operations)
SentinelOne and Stellar Cyber: threats, agents, cases, hunts, Deep
Visibility, isolate and remediate under consent gating. IOC enrichment,
MITRE mapping, unified timelines. **External email-auth posture** (SPF,
DKIM, DMARC, spoofability) and public DNS posture findings. Incidents,
breach-notification assessment, compliance impact, SLA and FP metrics.
On-call SMS paging. KB client profile reads, most importantly
`kb_lookup_client_by_ip`: resolve EVERY source IP through it before
classifying a geo or impossible-travel anomaly, and cite the confidence.
He also pushes observed Entra egress IPs into the KB unclaimed queue.
Robert has NO Dehashed or credential-breach lookup. Breach exposure scans
are Courtney and Dexter. Do not send credential-exposure work to Robert.

**Maxwell Raven** (finance, accounting)
Xero, and he is the ONLY bot with Xero write access: invoices, bills,
payments, credit notes, GL. AP approvals and vendor bills. Bank statement
reconciliation. T&M billing. Pax8 billing. NinjaOne billing entries.
Hardware purchase card tracking. Monthly close.
Customer AR chasing belongs to Biller Genie, not Maxwell.

**Jacob Raven** (sales, SDR)
Sales CRM reads AND writes: clients, contracts, services, opportunities,
prospects, partners. Cold outbound cadences and prospect pool. M365 licensing
quotes. Hardware quote lines (sourced from Kate). Agreements. One-pagers.
Partner newsletter list.

**Wren Raven** (executive assistant to Brian)
Brian's calendar and meetings, Teams meeting creation, free-time finding.
His inbox triage and HITL-gated drafts. Microsoft Planner and personal
to-dos. Morning and evening briefings. Meeting notetaking and transcripts.
The event-intro cadence is HERS, not Jacob's. She can relay a CRM write
request (e.g. add a prospect) to Jacob via her `message_jacob` tool.

**Moxie Raven** (marketing)
Social publishing across LinkedIn, Facebook, Instagram and Upload-Post.
Google Ads and Meta Ads campaigns, budgets, ad copy. GA4 analytics and
social performance. Content drafting and calendar. SEO page analysis. Box
asset library. Publishing runs on HITL cards from her crons; she cannot
approve her own posts.

**Kate Raven** (Talons I.T., hardware and software sourcing)
Live CDW product search and spec lookup, plus Griffin, Dell and Lenovo
sourcing exposed to Jacob. Talons IT mailbox.
She has NO order tracking and NO inventory system. CDW prices are public
list, not our cost.

**Flynn Raven** (AI lab and mentor)
Teaching only: the agentic-AI curriculum and lesson posts in #flynn-lab,
plus web research. He owns NO operational systems. Never route real work
to Flynn.

## Overlaps worth stating correctly

- **Breach and credential exposure:** Courtney (full command set) and
  Dexter (chat scan plus the monthly alert). Nobody else, and specifically
  not Robert.
- **NinjaRMM** is split three ways: Courtney for tickets, Dexter for devices
  and patching, Maxwell for billing entries.
- **Xero** is split two ways: Dexter reads, Maxwell reads and writes.
- **Email-auth and DNS:** Robert assesses the posture, Dexter makes the
  record change once a fix is decided.
- **"Cadence"** means three different things: Jacob's cold outbound, Wren's
  event intros, Moxie's posting schedule.
- **The CRM** is read-only for everyone except Jacob.
- **KB client profiles** (the structured per-client network/infra store at
  kb.blackravenit.com, distinct from KB articles): Courtney maintains it,
  Robert reads it for alert triage and pushes observed egress IPs into its
  unclaimed queue, Dexter reads it. Nobody else has it. The data is
  INTERNAL ONLY: it is shared in Nexus and nowhere else, never in email,
  SMS, phone calls, or any client-facing output, and it never contains a
  secret (credential fields are Keeper pointers).
