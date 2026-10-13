import SuperbetScraper from './superbet.mjs';

const HOST_PL = 'https://production-superbet-offer-pl.freetls.fastly.net';

export default class SuperbetPlScraper extends SuperbetScraper {
  id = 'superbet-pl';
  name = 'Superbet Poland';
  sourceIds = ['superbet-pl'];

  constructor(opts = {}) {
    super({
      ...opts,
      host: opts.host || HOST_PL,
      locale: opts.locale || 'pl-PL',
      id: 'superbet-pl',
      name: 'Superbet Poland',
      sourceIds: ['superbet-pl'],
    });
  }
}
