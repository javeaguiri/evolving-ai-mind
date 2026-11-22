// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/DomainRecords.jsx
//
// A domain page's records (docs/arch-web-app.md §4.4): a records panel for each of the domain's
// sources, as GET /domains/{domain} lists them from the registry — an entity with child tables as
// one panel that opens its records as documents, every other table and view as its own. Drawn,
// never stored. A domain whose records cannot be read draws its workflows alone.

import { useEffect, useState } from 'react';
import { SignInRequired }      from '../auth/session.mjs';
import { domainPanels }        from '../records/query.mjs';
import { PageBody }            from './PageBody.jsx';

/**
 * @param {object} props
 * @param {string} props.domain
 * @param {object} props.context  { api, locale, timeZone, onSignInRequired }
 */
export function DomainRecords({ domain, context }) {
  const { api, onSignInRequired } = context;
  const [sources, setSources] = useState(null);
  useEffect(() => {
    let live = true;
    setSources(null);
    api.get(`domains/${encodeURIComponent(domain)}`).then(
      body => { if (live) setSources(body.sources ?? []); },
      e => { if (e instanceof SignInRequired) onSignInRequired(); else if (live) setSources([]); },
    );
    return () => { live = false; };
  }, [api, domain, onSignInRequired]);
  if (!sources?.length) return null;
  return <PageBody pageKey={`d-${domain}`} panels={domainPanels(sources)} context={context} />;
}
