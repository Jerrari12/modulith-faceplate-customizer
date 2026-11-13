// Shop links for filaments, with the planner's disclosure rule (modulith-planner main 55a849b, js/workspaces/colors.js):
// a buy link keeps its plain label and carries rel=sponsored when its host pays a commission, and ONE plain line next
// to the links says who they go to. Amazon's sentence is its own words, verbatim. Never "paid link", never "affiliate
// link" alone. Keep these sentences identical to the planner's; change them there first.

const hostOf = href => { try { return new URL(href).hostname.toLowerCase(); } catch { return ''; } };
const PAID = [/(^|\.)amazon\./, /(^|\.)amzn\.to$/, /(^|\.)shop\.polymaker\.com$/];
const AMAZON = [/(^|\.)amazon\./, /(^|\.)amzn\.to$/];

export const isPaid = href => PAID.some(re => re.test(hostOf(href)));
const isAmazon = href => AMAZON.some(re => re.test(hostOf(href)));
const isPolymaker = href => /(^|\.)shop\.polymaker\.com$/.test(hostOf(href));

export const AMAZON_SENTENCE = 'As an Amazon Associate I earn from qualifying purchases.';
export const POLYMAKER_LINE = 'Polymaker links apply the JERRARI discount and earn me a small commission.';
const OTHER_LINE = 'I earn a small commission, at no extra cost to you.';

/** The one disclosure line for a set of links, or '' when every link is plain. */
export function disclosureFor(urls) {
  const amazon = urls.some(isAmazon), poly = urls.some(isPolymaker);
  return amazon && poly ? `${AMAZON_SENTENCE} ${POLYMAKER_LINE}` : poly ? POLYMAKER_LINE : amazon ? AMAZON_SENTENCE : urls.some(isPaid) ? OTHER_LINE : '';
}

/** rel for a buy link. */
export const relFor = href => (isPaid(href) ? 'noopener sponsored' : 'noopener');
