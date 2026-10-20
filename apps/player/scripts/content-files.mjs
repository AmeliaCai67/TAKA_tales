/** Source masters and iCloud conflict copies must never become public story assets. */
export function isPublishedName(name) {
    return !name.startsWith('_') && name !== '.DS_Store' && !/ [2-9](?:\.|$)/.test(name);
}
