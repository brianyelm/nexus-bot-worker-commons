// Device lifecycle reference: one end-of-life list for the whole fleet.
//
// Two consumers today. kb-app renders it live on the Client Profiles
// Infrastructure section and on the fleet EOL page; desk-app's nightly
// asset snapshot and client portal read the same lists (see Phase 7 in
// the plan) so a tech and a client never see two different answers for
// the same box.
//
// Deliberately dependency free and side effect free, like lib/brand.js:
// a consumer importing this bundles two arrays and three functions, no
// D1 query and no network call. That is the whole reason it is a module
// and not a table. Correcting a date is a reviewed code change plus a
// redeploy of the consuming workers, which is strictly better than the
// previous answer (a hand-run `wrangler d1 execute` against prod, with
// no editing UI anywhere).
//
// Matching is substring, first match wins, and both lists are sorted
// longest pattern first at module load so 'ms220-8' beats 'ms220' and
// 'mx64w' beats 'mx64' without any consumer re-sorting per request.

/** Years of age after which a device is worth flagging. */
export const AGING_YEARS = 3;

/** Years of age after which a device should be on a replacement plan. */
export const REPLACE_YEARS = 5;

/** Months of runway that count as "end of life is close". */
export const EOL_SOON_MONTHS = 12;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Sorts a reference list longest pattern first, so the most specific
 * match wins a substring test. Done once, at module load.
 * @param {Array<{pattern: string, label: string, eol_date: string, notes: string}>} rows
 * @returns {Array<object>} Same rows, longest pattern first
 */
function byPatternLength(rows) {
  return [...rows].sort((a, b) => b.pattern.length - a.pattern.length);
}

// Operating systems. Windows and macOS dates came from desk-app migration
// 0036; the ESXi, Linux and NAS rows are new, because desk-app only ever
// looked at Ninja-managed endpoints while kb-app's INFRA_KINDS includes
// hypervisor, nas and server. Without them a KB profile would render a
// column of "unknown" for exactly the gear Brian asked about.
//
// Known matching defect, documented rather than fixed: 'windows 10' also
// matches "Windows 10 Enterprise LTSC 2021" and stamps 2025-10-14, but
// LTSC 2021 actually runs to 2027-01-12. Fixing it needs an LTSC-aware
// pattern per channel; until an LTSC box shows up in a profile the extra
// patterns cost more than the wrong date does.
export const OS_EOL = byPatternLength([
  { pattern: "windows 7", label: "Windows 7", eol_date: "2020-01-14", notes: "Extended support ended" },
  { pattern: "windows 8", label: "Windows 8/8.1", eol_date: "2023-01-10", notes: "Extended support ended" },
  { pattern: "windows 10", label: "Windows 10", eol_date: "2025-10-14", notes: "Mainstream EOL; ESU available paid" },
  { pattern: "windows 11", label: "Windows 11", eol_date: "", notes: "Supported" },
  { pattern: "server 2008", label: "Windows Server 2008/R2", eol_date: "2020-01-14", notes: "Extended support ended" },
  { pattern: "server 2012", label: "Windows Server 2012/R2", eol_date: "2023-10-10", notes: "Extended support ended" },
  { pattern: "server 2016", label: "Windows Server 2016", eol_date: "2027-01-12", notes: "Extended support" },
  { pattern: "server 2019", label: "Windows Server 2019", eol_date: "2029-01-09", notes: "Extended support" },
  { pattern: "server 2022", label: "Windows Server 2022", eol_date: "2031-10-14", notes: "Extended support" },
  { pattern: "server 2025", label: "Windows Server 2025", eol_date: "", notes: "Supported" },
  { pattern: "mac os x 10.13", label: "macOS High Sierra", eol_date: "2020-12-01", notes: "No longer receiving security updates" },
  { pattern: "mac os x 10.14", label: "macOS Mojave", eol_date: "2021-10-25", notes: "No longer receiving security updates" },
  { pattern: "mac os x 10.15", label: "macOS Catalina", eol_date: "2022-09-12", notes: "No longer receiving security updates" },
  { pattern: "macos 11", label: "macOS Big Sur", eol_date: "2023-11-01", notes: "No longer receiving security updates" },
  { pattern: "macos 12", label: "macOS Monterey", eol_date: "2024-10-01", notes: "No longer receiving security updates" },
  { pattern: "macos 13", label: "macOS Ventura", eol_date: "2025-11-01", notes: "Final security-update year" },
  { pattern: "macos 14", label: "macOS Sonoma", eol_date: "", notes: "Supported" },
  { pattern: "macos 15", label: "macOS Sequoia", eol_date: "", notes: "Supported" },
  // Hypervisors. Broadcom moved ESXi 7.0 general support to 2025-10-02
  // and 8.0 to 2027-10-11; 6.5 and 6.7 both ended 2022-10-15.
  { pattern: "esxi 6.5", label: "VMware ESXi 6.5", eol_date: "2022-10-15", notes: "General support ended" },
  { pattern: "esxi 6.7", label: "VMware ESXi 6.7", eol_date: "2022-10-15", notes: "General support ended" },
  { pattern: "esxi 7.0", label: "VMware ESXi 7.0", eol_date: "2025-10-02", notes: "General support ended" },
  { pattern: "esxi 8.0", label: "VMware ESXi 8.0", eol_date: "2027-10-11", notes: "General support" },
  { pattern: "proxmox 7", label: "Proxmox VE 7", eol_date: "2024-07-31", notes: "Support ended" },
  { pattern: "proxmox 8", label: "Proxmox VE 8", eol_date: "2026-07-31", notes: "Supported" },
  // Linux server distributions.
  { pattern: "ubuntu 18.04", label: "Ubuntu 18.04 LTS", eol_date: "2023-05-31", notes: "Standard support ended; ESM available paid" },
  { pattern: "ubuntu 20.04", label: "Ubuntu 20.04 LTS", eol_date: "2025-05-31", notes: "Standard support ended; ESM available paid" },
  { pattern: "ubuntu 22.04", label: "Ubuntu 22.04 LTS", eol_date: "2027-06-01", notes: "Standard support" },
  { pattern: "ubuntu 24.04", label: "Ubuntu 24.04 LTS", eol_date: "2029-06-01", notes: "Standard support" },
  { pattern: "centos 7", label: "CentOS 7", eol_date: "2024-06-30", notes: "Project ended" },
  { pattern: "centos 8", label: "CentOS 8", eol_date: "2021-12-31", notes: "Project ended early" },
  { pattern: "red hat enterprise linux 7", label: "RHEL 7", eol_date: "2024-06-30", notes: "Maintenance support ended" },
  { pattern: "red hat enterprise linux 8", label: "RHEL 8", eol_date: "2029-05-31", notes: "Maintenance support" },
  { pattern: "red hat enterprise linux 9", label: "RHEL 9", eol_date: "2032-05-31", notes: "Maintenance support" },
  { pattern: "rhel 7", label: "RHEL 7", eol_date: "2024-06-30", notes: "Maintenance support ended" },
  { pattern: "rhel 8", label: "RHEL 8", eol_date: "2029-05-31", notes: "Maintenance support" },
  { pattern: "rhel 9", label: "RHEL 9", eol_date: "2032-05-31", notes: "Maintenance support" },
  { pattern: "debian 10", label: "Debian 10 Buster", eol_date: "2024-06-30", notes: "LTS ended" },
  { pattern: "debian 11", label: "Debian 11 Bullseye", eol_date: "2026-08-31", notes: "LTS" },
  { pattern: "debian 12", label: "Debian 12 Bookworm", eol_date: "2028-06-30", notes: "LTS" },
  // NAS firmware, which Ninja and Meraki never report, so these only
  // resolve when a tech types the DSM version into the OS field.
  { pattern: "dsm 6", label: "Synology DSM 6", eol_date: "2025-06-30", notes: "Security updates ended" },
  { pattern: "dsm 7", label: "Synology DSM 7", eol_date: "", notes: "Supported" },
]);

// Cisco Meraki hardware end-of-support, from Cisco's published EOL
// announcements. Copied from desk-app migration 0038.
export const HARDWARE_EOL = byPatternLength([
  // MX security appliances
  { pattern: "mx50", label: "Meraki MX50", eol_date: "2016-09-01", notes: "End of support" },
  { pattern: "mx60", label: "Meraki MX60", eol_date: "2022-10-24", notes: "End of support (incl MX60W)" },
  { pattern: "mx70", label: "Meraki MX70", eol_date: "2017-03-31", notes: "End of support" },
  { pattern: "mx80", label: "Meraki MX80", eol_date: "2023-08-30", notes: "End of support" },
  { pattern: "mx90", label: "Meraki MX90", eol_date: "2021-04-26", notes: "End of support" },
  { pattern: "mx64w", label: "Meraki MX64W", eol_date: "2027-07-26", notes: "End of support" },
  { pattern: "mx64", label: "Meraki MX64", eol_date: "2027-07-26", notes: "End of support" },
  { pattern: "mx65w", label: "Meraki MX65W", eol_date: "2026-05-28", notes: "End of support" },
  { pattern: "mx65", label: "Meraki MX65", eol_date: "2026-05-28", notes: "End of support" },
  { pattern: "mx84", label: "Meraki MX84", eol_date: "2026-10-31", notes: "End of support" },
  { pattern: "mx100", label: "Meraki MX100", eol_date: "2027-02-01", notes: "End of support" },
  { pattern: "mx400", label: "Meraki MX400", eol_date: "2025-05-20", notes: "End of support" },
  { pattern: "mx600", label: "Meraki MX600", eol_date: "2025-05-20", notes: "End of support" },
  { pattern: "vmx100", label: "Meraki vMX100", eol_date: "2027-12-22", notes: "End of support" },
  { pattern: "mx67", label: "Meraki MX67", eol_date: "", notes: "Current" },
  { pattern: "mx68", label: "Meraki MX68", eol_date: "", notes: "Current" },
  { pattern: "mx75", label: "Meraki MX75", eol_date: "", notes: "Current" },
  { pattern: "mx85", label: "Meraki MX85", eol_date: "", notes: "Current" },
  { pattern: "mx95", label: "Meraki MX95", eol_date: "", notes: "Current" },
  { pattern: "mx105", label: "Meraki MX105", eol_date: "", notes: "Current" },
  { pattern: "mx250", label: "Meraki MX250", eol_date: "", notes: "Current" },
  { pattern: "mx450", label: "Meraki MX450", eol_date: "", notes: "Current" },
  // MS switches
  { pattern: "ms22p", label: "Meraki MS22P", eol_date: "2021-04-26", notes: "End of support" },
  { pattern: "ms22", label: "Meraki MS22", eol_date: "2021-04-26", notes: "End of support" },
  { pattern: "ms42p", label: "Meraki MS42P", eol_date: "2021-04-26", notes: "End of support" },
  { pattern: "ms42", label: "Meraki MS42", eol_date: "2021-04-26", notes: "End of support" },
  { pattern: "ms220-8", label: "Meraki MS220-8", eol_date: "2025-09-21", notes: "End of support" },
  { pattern: "ms220", label: "Meraki MS220", eol_date: "2024-07-29", notes: "End of support" },
  { pattern: "ms320", label: "Meraki MS320", eol_date: "2024-03-31", notes: "End of support" },
  { pattern: "ms420", label: "Meraki MS420", eol_date: "2023-10-31", notes: "End of support" },
  { pattern: "ms350", label: "Meraki MS350", eol_date: "2030-08-08", notes: "End of support" },
  { pattern: "ms355", label: "Meraki MS355", eol_date: "2030-08-08", notes: "End of support" },
  { pattern: "ms390", label: "Meraki MS390", eol_date: "2032-03-28", notes: "End of support" },
  { pattern: "ms410", label: "Meraki MS410", eol_date: "2029-09-28", notes: "End of support" },
  { pattern: "ms425", label: "Meraki MS425", eol_date: "2029-09-28", notes: "End of support" },
  { pattern: "ms210", label: "Meraki MS210", eol_date: "2031-04-30", notes: "End of support" },
  { pattern: "ms225", label: "Meraki MS225", eol_date: "2031-04-30", notes: "End of support" },
  { pattern: "ms250", label: "Meraki MS250", eol_date: "2030-08-08", notes: "End of support" },
  { pattern: "ms120", label: "Meraki MS120", eol_date: "2030-03-28", notes: "End of support" },
  { pattern: "ms125", label: "Meraki MS125", eol_date: "2030-03-28", notes: "End of support" },
  { pattern: "ms130", label: "Meraki MS130", eol_date: "", notes: "Current" },
  { pattern: "ms150", label: "Meraki MS150", eol_date: "", notes: "Current" },
  // MR access points
  { pattern: "mr11", label: "Meraki MR11", eol_date: "2017-08-30", notes: "End of support" },
  { pattern: "mr12", label: "Meraki MR12", eol_date: "2022-10-24", notes: "End of support" },
  { pattern: "mr14", label: "Meraki MR14", eol_date: "2017-08-30", notes: "End of support" },
  { pattern: "mr16", label: "Meraki MR16", eol_date: "2021-05-31", notes: "End of support" },
  { pattern: "mr18", label: "Meraki MR18", eol_date: "2024-03-31", notes: "End of support" },
  { pattern: "mr20", label: "Meraki MR20", eol_date: "2028-06-13", notes: "End of support" },
  { pattern: "mr21", label: "Meraki MR21", eol_date: "2026-06-19", notes: "End of support" },
  { pattern: "mr24", label: "Meraki MR24", eol_date: "2021-05-31", notes: "End of support" },
  { pattern: "mr26", label: "Meraki MR26", eol_date: "2023-05-09", notes: "End of support" },
  { pattern: "mr30h", label: "Meraki MR30H", eol_date: "2027-07-26", notes: "End of support" },
  { pattern: "mr32", label: "Meraki MR32", eol_date: "2024-07-31", notes: "End of support" },
  { pattern: "mr33", label: "Meraki MR33", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr34", label: "Meraki MR34", eol_date: "2023-10-31", notes: "End of support" },
  { pattern: "mr36h", label: "Meraki MR36H", eol_date: "2031-12-31", notes: "End of support" },
  { pattern: "mr36", label: "Meraki MR36", eol_date: "2031-12-31", notes: "End of support" },
  { pattern: "mr42e", label: "Meraki MR42E", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr42", label: "Meraki MR42", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr44", label: "Meraki MR44", eol_date: "2031-12-31", notes: "End of support" },
  { pattern: "mr45", label: "Meraki MR45", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr46e", label: "Meraki MR46E", eol_date: "2031-12-31", notes: "End of support" },
  { pattern: "mr46", label: "Meraki MR46", eol_date: "2031-12-31", notes: "End of support" },
  { pattern: "mr52", label: "Meraki MR52", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr53e", label: "Meraki MR53E", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr53", label: "Meraki MR53", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr55", label: "Meraki MR55", eol_date: "2027-08-01", notes: "End of support" },
  { pattern: "mr56", label: "Meraki MR56", eol_date: "2030-08-07", notes: "End of support" },
  { pattern: "mr58", label: "Meraki MR58", eol_date: "2017-10-30", notes: "End of support" },
  { pattern: "mr62", label: "Meraki MR62", eol_date: "2024-11-15", notes: "End of support" },
  { pattern: "mr66", label: "Meraki MR66", eol_date: "2024-06-09", notes: "End of support" },
  { pattern: "mr70", label: "Meraki MR70", eol_date: "2029-02-19", notes: "End of support" },
  { pattern: "mr71", label: "Meraki MR71", eol_date: "2026-06-19", notes: "End of support" },
  { pattern: "mr72", label: "Meraki MR72", eol_date: "2024-04-30", notes: "End of support" },
  { pattern: "mr74", label: "Meraki MR74", eol_date: "2026-07-21", notes: "End of support" },
  { pattern: "mr84", label: "Meraki MR84", eol_date: "2026-07-21", notes: "End of support" },
  // MV cameras
  { pattern: "mv21", label: "Meraki MV21", eol_date: "2026-06-19", notes: "End of support" },
  { pattern: "mv71", label: "Meraki MV71", eol_date: "2026-06-19", notes: "End of support" },
  { pattern: "mv12", label: "Meraki MV12", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv13", label: "Meraki MV13", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv22", label: "Meraki MV22", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv32", label: "Meraki MV32", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv33", label: "Meraki MV33", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv63", label: "Meraki MV63", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv72", label: "Meraki MV72", eol_date: "2030-12-31", notes: "End of support" },
  { pattern: "mv93", label: "Meraki MV93", eol_date: "2030-12-31", notes: "End of support" },
  // MG cellular gateways
  { pattern: "mg21e", label: "Meraki MG21E", eol_date: "2029-09-18", notes: "End of support" },
  { pattern: "mg21", label: "Meraki MG21", eol_date: "2029-09-18", notes: "End of support" },
  { pattern: "mg51e", label: "Meraki MG51E", eol_date: "2030-05-30", notes: "End of support" },
  { pattern: "mg51", label: "Meraki MG51", eol_date: "2030-05-30", notes: "End of support" },
  // MT sensors
  { pattern: "mt10", label: "Meraki MT10", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt11", label: "Meraki MT11", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt12", label: "Meraki MT12", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt14", label: "Meraki MT14", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt15", label: "Meraki MT15", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt20", label: "Meraki MT20", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt30", label: "Meraki MT30", eol_date: "2031-11-30", notes: "End of support" },
  { pattern: "mt40", label: "Meraki MT40", eol_date: "2031-11-30", notes: "End of support" },
  // Z teleworker gateways
  { pattern: "z1", label: "Meraki Z1", eol_date: "2025-07-27", notes: "End of support" },
  { pattern: "z3c", label: "Meraki Z3C", eol_date: "2029-09-04", notes: "End of support" },
  { pattern: "z3", label: "Meraki Z3", eol_date: "2029-09-04", notes: "End of support" },
]);

/**
 * Resolves an operating system string to its end-of-life record.
 * @param {string} osName - e.g. "Microsoft Windows Server 2019 Standard"
 * @returns {{label: string, eol_date: string, notes: string}|null} null when nothing matched
 */
export function resolveOsEol(osName) {
  const needle = String(osName || "").toLowerCase();
  if (!needle) return null;
  for (const row of OS_EOL) {
    if (needle.includes(row.pattern)) return { label: row.label, eol_date: row.eol_date, notes: row.notes };
  }
  return null;
}

/**
 * Resolves a hardware make/model string to its end-of-support record.
 *
 * Gated to Cisco Meraki on purpose. The model patterns are short enough
 * ('z1', 'mt10', 'mr20') that running them against free text would match
 * a Dell or a Fortinet by accident, and a confidently wrong EOL date is
 * worse than an honest unknown.
 *
 * @param {string} makeModel - e.g. "Cisco Meraki MS225-48LP"
 * @returns {{label: string, eol_date: string, notes: string}|null} null when nothing matched
 */
export function resolveHardwareEol(makeModel) {
  const needle = String(makeModel || "").toLowerCase();
  if (!needle.startsWith("cisco meraki")) return null;
  for (const row of HARDWARE_EOL) {
    if (needle.includes(row.pattern)) return { label: row.label, eol_date: row.eol_date, notes: row.notes };
  }
  return null;
}

/**
 * Age in years from a purchase date, or null when there is no date.
 * @param {string} purchasedOn - "YYYY", "YYYY-MM" or "YYYY-MM-DD"
 * @param {Date} today
 * @returns {number|null} Rounded to one decimal
 */
export function ageYears(purchasedOn, today) {
  const raw = String(purchasedOn || "").trim();
  if (!raw) return null;
  // A tech who only knows the year types "2019", so widen a partial date
  // to a real one rather than rejecting it.
  const full = raw.length === 4 ? `${raw}-01-01` : raw.length === 7 ? `${raw}-01` : raw;
  const then = Date.parse(`${full}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const years = (today.getTime() - then) / MS_PER_YEAR;
  return years < 0 ? null : Math.round(years * 10) / 10;
}

/**
 * The lifecycle read for one infrastructure row.
 *
 * `status` has FOUR values where desk-app's resolver has three. desk-app
 * returns {label:"", date:""} both for "no pattern matched" and for "the
 * pattern matched and the vendor still supports it", which reads as OK
 * either way. kb-app must not do that: its hard rule is never to guess
 * attribution, and "we have no idea what this box is" is a different
 * answer from "this box is current". `unknown` is what tells Brian how
 * much manual entry is still outstanding.
 *
 * @param {object} row - client_infrastructure row (make_model, os_name, purchased_on)
 * @param {Date} [today] - injected for tests
 * @returns {{status: string, source: string, eol_date: string|null, eol_label: string|null, months_left: number|null, age_years: number|null, age_flag: string}}
 */
export function computeLifecycle(row, today = new Date()) {
  // Hardware end-of-support answers the question for switches, APs and
  // firewalls; the OS answers it for servers. Hardware wins when both
  // resolve, because a dead chassis outranks a patchable OS.
  const hardware = resolveHardwareEol(row?.make_model);
  const os = hardware ? null : resolveOsEol(row?.os_name);
  const hit = hardware || os;
  const source = hardware ? "hardware" : os ? "os" : "none";

  const age = ageYears(row?.purchased_on, today);
  const ageFlag = age === null ? "unknown" : age >= REPLACE_YEARS ? "replace" : age >= AGING_YEARS ? "aging" : "ok";

  if (!hit) {
    return { status: "unknown", source, eol_date: null, eol_label: null, months_left: null, age_years: age, age_flag: ageFlag };
  }
  if (!hit.eol_date) {
    return { status: "ok", source, eol_date: null, eol_label: hit.label, months_left: null, age_years: age, age_flag: ageFlag };
  }

  const end = Date.parse(`${hit.eol_date}T00:00:00Z`);
  const monthsLeft = Math.round(((end - today.getTime()) / MS_PER_YEAR) * 12);
  const status = end <= today.getTime() ? "eol" : monthsLeft <= EOL_SOON_MONTHS ? "eol_soon" : "ok";
  return { status, source, eol_date: hit.eol_date, eol_label: hit.label, months_left: monthsLeft, age_years: age, age_flag: ageFlag };
}

/**
 * Rolls a set of lifecycle reads up into counts for a section header.
 * @param {Array<{status: string}>} lifecycles
 * @returns {{total: number, eol: number, eol_soon: number, ok: number, unknown: number}}
 */
export function summarizeLifecycles(lifecycles) {
  const counts = { total: 0, eol: 0, eol_soon: 0, ok: 0, unknown: 0 };
  for (const life of lifecycles || []) {
    counts.total++;
    if (counts[life?.status] !== undefined) counts[life.status]++;
  }
  return counts;
}
