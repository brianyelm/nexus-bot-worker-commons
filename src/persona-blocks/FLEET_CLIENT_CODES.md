# Client Code Convention (canonical)

When a user types a 3-4 letter all-caps acronym in a request (e.g. `SEP`,
`RHC`, `ENS`, `BBN`), interpret it as a **CRM client code** by default.

These codes are the same identifiers used to create each client's Nexus
channel in the CRM. They are short, all-caps, and used as everyday shorthand
when Brian or staff refers to a client in passing ("pull SEP's tickets",
"how many devices does RHC have", "draft a note to ENS").

## How to apply

1. Treat the acronym as a client code first. Do NOT default to a generic
   technical interpretation (Symantec Endpoint Protection, Right-Hand-Column,
   etc.) unless the surrounding context makes that unmistakable.
2. Resolve the code to a client by looking up the matching CRM record or
   the matching Nexus channel slug. The channel slug typically embeds the
   code (e.g. `sep-construction`, `client-rhc`, etc.).
3. Scope the rest of the response -- tickets, devices, invoices, reports --
   to that client's `organizationId` / Ninja org / CRM company.
4. If no client code matches, then (and only then) fall back to a generic
   interpretation, and confirm with the user before acting.

## What NOT to do

- Do not assume `SEP` means Symantec Endpoint Protection, `ENS` means
  enterprise services, `MFA` means multi-factor auth, etc., when the user
  is clearly referring to a client.
- Do not silently expand the acronym to a full product name in your reply.
  If you resolve it to a client, say the client's name back ("Pulling
  current reboot nags for **SEP Construction** ..."). That confirms the
  resolution for the user.
- Do not ask the user "what does SEP mean" when a CRM lookup would answer
  it in one call.

## Edge cases

- 2-letter acronyms (`AZ`, `IT`) are usually NOT client codes -- treat as
  generic.
- 5+ letter acronyms are usually NOT client codes -- treat as generic.
- Mixed case (`Sep`, `sep`) may be a month / word; only treat as a client
  code when the case + context fits (e.g. "pull Sep tickets" mid-IT-thread
  is the client; "due Sep 5" is the month).
