/**
 * Rule-based heuristics to map form fields to profile keys.
 * Matches field name/id/label to profile keys (email, name, phone, etc.)
 */

const PROFILE_KEYS = ["name", "email", "phone", "address", "city", "state"];

const KEY_ALIASES = {
  name: ["name", "fullname", "full_name", "full-name", "username", "user_name", "firstname", "first_name", "first-name", "lastname", "last_name", "last-name", "fname", "lname"],
  email: ["email", "e-mail", "emailaddress", "email_address", "mail"],
  phone: ["phone", "telephone", "tel", "mobile", "cell", "phonenumber", "phone_number"],
  address: ["address", "street", "address1", "address_1", "addr", "streetaddress", "street_address"],
  city: ["city", "town"],
  state: ["state", "province", "region", "zip", "postal", "zipcode", "postalcode", "postal_code"],
};

function normalize(s) {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[-_\s]/g, "")
    .trim();
}

function inferProfileKey(field) {
  const candidates = [
    field.id,
    field.name,
    field.label,
    field.placeholder,
  ].filter(Boolean);

  const norm = normalize(candidates.join(" "));

  for (const key of PROFILE_KEYS) {
    const aliases = KEY_ALIASES[key] || [key];
    for (const alias of aliases) {
      if (norm.includes(normalize(alias))) return key;
    }
  }
  return null;
}

/**
 * Map extracted fields to profile.
 * Returns { fieldId: value } using profile values where we can infer the key.
 */
export function heuristicMap(fields, profile) {
  const mapping = {};
  for (const field of fields) {
    const key = inferProfileKey(field);
    if (key && profile[key]) {
      mapping[field.id] = profile[key];
    }
  }
  return mapping;
}
