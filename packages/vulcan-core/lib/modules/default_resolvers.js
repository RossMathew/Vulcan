/*

Default list, single, and total resolvers

*/

import { Utils, debug, debugGroup, debugGroupEnd, Connectors, getTypeName, getCollectionName } from 'meteor/vulcan:lib';
import { createError } from 'apollo-errors';

const defaultOptions = {
  cacheMaxAge: 300,
};

// note: for some reason changing resolverOptions to "options" throws error
export function getDefaultResolvers(options) {

  let typeName, collectionName, resolverOptions;
  if (typeof arguments[0] === 'object') {
    // new single-argument API
    typeName = arguments[0].typeName;
    collectionName = getCollectionName(typeName); // TODO: find more reliable way to get type name from collection name
    resolverOptions = arguments[0].options || defaultOptions;
  } else {
    // OpenCRUD backwards compatibility
    collectionName = arguments[0];
    typeName = getTypeName(collectionName);
    resolverOptions = arguments[1] || defaultOptions;
  }
  
  return {
    // resolver for returning a list of documents based on a set of query terms

    multi: {
      description: `A list of ${typeName} documents matching a set of query terms`,

      async resolver(root, { input = {} }, context, { cacheControl }) {
        const { terms = {}, enableCache = false, enableTotal = true } = input;

        debug('');
        debugGroup(`--------------- start \x1b[35m${typeName} Multi Resolver\x1b[0m ---------------`);
        debug(`Options: ${JSON.stringify(resolverOptions)}`);
        debug(`Terms: ${JSON.stringify(terms)}`);

        if (cacheControl && enableCache) {
          const maxAge = resolverOptions.cacheMaxAge || defaultOptions.cacheMaxAge;
          cacheControl.setCacheHint({ maxAge });
        }

        // get currentUser and Users collection from context
        const { currentUser, Users } = context;
        
        // get collection based on collectionName argument
        const collection = context[collectionName];

        // get selector and options from terms and perform Mongo query
        let { selector, options } = await collection.getParameters(terms, {}, context);
        options.skip = terms.offset;

        debug({ selector, options });

        const docs = await Connectors.find(collection, selector, options);

        // if collection has a checkAccess function defined, remove any documents that doesn't pass the check
        const viewableDocs = collection.checkAccess
          ? _.filter(docs, doc => collection.checkAccess(currentUser, doc))
          : docs;

        // take the remaining documents and remove any fields that shouldn't be accessible
        const restrictedDocs = Users.restrictViewableFields(currentUser, collection, viewableDocs);

        // prime the cache
        restrictedDocs.forEach(doc => collection.loader.prime(doc._id, doc));

        debug(`\x1b[33m=> ${restrictedDocs.length} documents returned\x1b[0m`);
        debugGroupEnd();
        debug(`--------------- end \x1b[35m${typeName} Multi Resolver\x1b[0m ---------------`);
        debug('');

        const data = { results: restrictedDocs };
        
        if (enableTotal) {
          // get total count of documents matching the selector
          data.totalCount = await Connectors.count(collection, selector);
        }

        // return results
        return data;
      },
    },

    // resolver for returning a single document queried based on id or slug

    single: {
      description: `A single ${typeName} document fetched by ID or slug`,

      async resolver(root, { input = {} }, context, { cacheControl }) {
        const { selector = {}, enableCache = false } = input;
        const { documentId, slug } = selector;

        debug('');
        debugGroup(`--------------- start \x1b[35m${typeName} Single Resolver\x1b[0m ---------------`);
        debug(`Options: ${JSON.stringify(resolverOptions)}`);
        debug(`DocumentId: ${documentId}, Slug: ${slug}`);

        if (cacheControl && enableCache) {
          const maxAge = resolverOptions.cacheMaxAge || defaultOptions.cacheMaxAge;
          cacheControl.setCacheHint({ maxAge });
        }

        const { currentUser, Users } = context;
        const collection = context[collectionName];

        // don't use Dataloader if doc is selected by slug
        const doc = documentId
          ? await collection.loader.load(documentId)
          : slug
            ? await Connectors.get(collection, { slug })
            : await Connectors.get(collection);

        if (!doc) {
          const MissingDocumentError = createError('app.missing_document', { message: 'app.missing_document' });
          throw new MissingDocumentError({ data: { documentId, slug } });
        }

        // if collection has a checkAccess function defined, use it to perform a check on the current document
        // (will throw an error if check doesn't pass)
        if (collection.checkAccess) {
          Utils.performCheck(collection.checkAccess, currentUser, doc, collection, documentId);
        }

        const restrictedDoc = Users.restrictViewableFields(currentUser, collection, doc);

        debugGroupEnd();
        debug(`--------------- end \x1b[35m${typeName} Single Resolver\x1b[0m ---------------`);
        debug('');

        // filter out disallowed properties and return resulting document
        return { result: restrictedDoc };
      },
    },
  };
}