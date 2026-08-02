# Competitor Displacement: Invoice to BRIT Opportunity

How I turn a competitor's invoice or quote into a single Black Raven IT
opportunity. Brian or a rep hands me the incumbent's pricing (PDF, screenshot,
or pasted text) and I produce a clean BRIT opportunity with the right catalog
service lines, prompting only for the SKUs I genuinely cannot match on my own.

This is an INTERNAL workflow. Pricing, rates, and margins are fine to discuss
in Nexus with Brian and the team. They never go into a prospect-facing email
(the no-pricing-in-email rule still holds).

## When this fires

- "Convert this competitor invoice into an opportunity"
- "Here is what [prospect] pays [CISO / Cerberus / their current MSP] now, build the BRIT version"
- A prospect forwards their current MSP agreement during discovery and Brian wants a like-for-like

## The five-step process

### 1. Parse every line

Pull out, for each line: the competitor SKU/code, the description, quantity,
unit rate, the extended monthly amount, and any term (1yr / 3yr). Note the
billing entity and address. Sum the total so I have the incumbent monthly spend
to anchor against.

### 2. Consolidate entities into ONE opportunity

One client can be billed across multiple invoices or legal entities (a parent
org plus a fundraising arm, a holding co plus an operating co). If the addresses
or names tie back to the same organization, they roll into a SINGLE BRIT
opportunity. Do not create one opp per invoice. Use the parent org as the deal
title.

### 3. Map each line to the BRIT catalog by FUNCTION, not name

Match on what the service does, not what the vendor named it. Every line lands
in one of three buckets:

- **Clean 1:1** - a BRIT catalog id does the same job (e.g. their per-device
  managed plan to `MSEndpoints`, their cloud file storage to `Axcient`).
- **They itemize, we bundle** - the competitor charges a separate line for
  something BRIT includes inside `MSEndpoints`. Fold it in; do not create a
  BRIT line for it. `MSEndpoints` already covers "Firewalls, Routers, Switches
  and APs," RMM, EDR/MDR, XDR, and SaaS email backup. So a competitor's
  separate firewall-management, switch-management, wireless-management, RMM,
  antivirus, or SIEM lines almost always fold into `MSEndpoints`.
- **Unmatched / ambiguous** - no clean BRIT id, or more than one plausible
  mapping with real dollar consequences. DO NOT GUESS. Collect these and prompt
  the user in step 4.

The canonical catalog ids live in the sales-app (`crm_create_opportunity`
accepts them): `MSEndpoints`, `UMSEndpoints`, `MXDR`, `ProofpointEmail`,
`SaaSEmailBackup`, `ServerBackup`, `MSBCDR`, `MVeeamSvr`, `SecAwareness`,
`VCIO`, `VCIOProject`, `Axcient`, `AIConsulting`, `M365Licenses`,
`M365BusStdWTms`, `ExchOnlinePlan1`, `M365EntraP2`, `Labor`, `LaborFlat`,
`TMStandard`, `TMAfterHours`, `OnsiteOOS`, `Hardware/Software`,
`LTECellularStaticIP`, `VoIPWirelessExt`. There is NO standalone "managed
server," "web filtering," "RMM," or "antivirus" SKU; those fold into
`MSEndpoints` or need a user decision.

### 4. Prompt the user for what I cannot resolve

For each ambiguous SKU and for the pricing strategy, ask Brian in my reply.
Lead with my recommended mapping, then give the alternatives, then wait for his
answer before writing anything. Good prompts look like:

> Three of their lines I can map cleanly (SMSG to MSEndpoints, Tech Connect
> Drive to Axcient, network management folds into MSEndpoints). Two I need your
> call on:
> 1. Their 6 managed servers - roll into MSEndpoints as endpoints, or price
>    separately? (I recommend rolling in.)
> 2. Their Datto BCDR appliance at $1,423.50/mo - map to MSBCDR per server, or
>    ServerBackup? (I recommend MSBCDR x server count.)
> And on pricing: match their rates for a clean displacement, use our standard
> catalog, or beat them by a set percent?

Never silently pick an ambiguous mapping. The whole point is that the human
closes the gap on the handful of SKUs I cannot.

### 5. Pricing strategy then build

Once the mappings and pricing approach are confirmed:

- **Match incumbent** - override catalog rates so the client's total lands at
  or just under what they pay now. This is the usual displacement play.
- **Standard catalog** - use BRIT list rates (often higher; use when we are
  clearly the premium upgrade).
- **Beat by X%** - undercut to win.

Then: `crm_search` for the client. If they are not in the CRM, create a
prospect first (`crm_create_prospect`, full contact + structured address).
Then `crm_create_opportunity` with the mapped service lines. Set `term` to
match the incumbent's longest commitment when there is one (a 3-year BCDR line
means a 3-year opp unless Brian says otherwise). Summarize the resulting MRR and
the delta vs the incumbent, and include the returned `crm_url`.

## CISO Global / Cerberus Sentinel ("SentryCOM") crosswalk

CISO Global bills under Cerberus Sentinel and brands its managed stack
"SentryCOM," with Datto for BCDR. We will see this competitor again, so here is
the standing crosswalk:

| CISO / SentryCOM line | Code | BRIT mapping | Notes |
|---|---|---|---|
| Secured Managed Services Gold (per device) | SCOM-SMSG | `MSEndpoints` | Their core managed endpoint plan. Direct 1:1. |
| Server Management (physical + virtual) | SCOM-SRVMGMT | `MSEndpoints` (servers as endpoints) | No standalone BRIT server SKU. Roll servers into the endpoint count unless Brian wants a premium server rate. |
| Firewall Management (Gold) | SCOM-FRM | folds into `MSEndpoints` | BRIT includes firewall support. |
| Switch / LAN Management | SCOM-LANM | folds into `MSEndpoints` | BRIT includes switch support. |
| Wireless Management | SCOM-WIREM | folds into `MSEndpoints` | BRIT includes AP support. |
| Web Filtering | SCOM-WEBFILTER | folds into `MSEndpoints` | DNS/content filtering is part of our stack. |
| Tech Connect Drive (cloud storage, per user) | TC_DRV | `Axcient` | Cloud storage / sync / DR. Near-exact, same per-user unit. |
| Datto BCDR appliance | S-S5-xx-TBRx | `MSBCDR` x server count (or `ServerBackup`) | Ambiguous; confirm structure and whether we are replacing the appliance. |

## Worked example: Claretian Missionaries (2026-05-26)

Two CISO invoices, same org at 205 W. Monroe, Chicago: Claretian Missionaries
USA Province ($7,583.89/mo) and its fundraising arm St. Jude League (Datto BCDR,
$1,423.50/mo). Combined incumbent spend: $9,007.39/mo. Consolidated into ONE
BRIT opportunity.

Brian's calls: match incumbent rates; roll the 6 servers into MSEndpoints and
map Datto to MSBCDR x6; fold the network-management lines into Managed Services.

Resulting opportunity:

    MSEndpoints x 83 @ $79.31   = $6,583.23/mo   (77 workstations + 6 servers; firewall/switch/wireless/web-filter folded in)
    MSBCDR      x  6 @ $237.25  = $1,423.50/mo   (Datto BCDR appliance; $1,423.50 / 6 servers)
    Axcient     x  2 @ $12.36   =    $24.72/mo   (Tech Connect Drive)

    MRR: $8,031.45/mo

About $976/mo (11%) under the incumbent, because the $803/mo of à-la-carte
network management plus web filtering becomes included value inside Managed
Services, and the servers roll in at the workstation rate. That undercut IS the
pitch: same coverage, network management included, lower bill.

## Anti-patterns

- Do not invent a BRIT catalog id. If nothing fits, it is an unmatched line for
  the user to resolve, not a SKU I make up.
- Do not create a separate opportunity per invoice when the invoices belong to
  one organization. Consolidate.
- Do not itemize what BRIT bundles. A competitor's separate firewall / switch /
  wireless / RMM / antivirus lines fold into `MSEndpoints`; listing them
  separately double-counts and muddies the comparison.
- Do not silently resolve an ambiguous mapping. Recommend, then ask.
- Do not match on product name. "SentryCOM Gold" is not a BRIT product; match on
  the function (managed endpoint) instead.
- Do not put any of this pricing into a prospect-facing email. Internal Nexus
  and the CRM only.
- Do not skip the catalog-rate override when Brian says "match incumbent." The
  sales-app recomputes MRR from the rates I send, so the rate per line is what
  lands on the proposal.
