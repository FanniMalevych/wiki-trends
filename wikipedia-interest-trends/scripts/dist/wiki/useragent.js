import { VERSION } from "../meta.js";
// Wikimedia blocks generic clients; the User-Agent must name the tool and a way to reach its owner.
// https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
export const DEFAULT_CONTACT = "https://github.com/FanniMalevych/wiki-trends";
export function userAgent() {
    const contact = process.env.WIT_CONTACT?.trim() || DEFAULT_CONTACT;
    return `wikipedia-interest-trends/${VERSION} (${contact}) node/${process.versions.node}`;
}
