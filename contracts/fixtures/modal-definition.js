// Canonical valid modal DEFINITION (bot -> Nexus attach). Pre-fill values are
// under `value` (the key the Nexus UI actually reads); `default_value` is
// non-conforming and renders blank.
export const modalDefinitionFixture = {
  modal_id: "edit-draft:vr-9c1d",
  title: "Edit Draft",
  fields: [
    { name: "subject", label: "Subject", type: "text", max_length: 200, value: "Re: April invoice - quick question" },
    { name: "body", label: "Reply body (HTML)", type: "textarea", max_length: 4000, value: "Hi Dana, thanks for flagging the April line." },
  ],
  callback_url: "https://maxwell-worker.blackravenit.workers.dev/api/internal/modal-submit",
  metadata: { approval_id: "vr-9c1d" },
};
