/**
 * A DocumentDB stored procedure that updates a document by id, using a similar syntax to MongoDB's update operator.<br/>
 * <br/>
 * The following operations are supported:<br/>
 * <br/>
 * Field Operators:<br/>
 * <ul>
 *   <li>$inc - Increments the value of the field by the specified amount.</li>
 *   <li>$mul - Multiplies the value of the field by the specified amount.</li>
 *   <li>$rename - Renames a field.</li>
 *   <li>$set - Sets the value of a field in a document.</li>
 *   <li>$unset - Removes the specified field from a document.</li>
 *   <li>$min - Only updates the field if the specified value is less than the existing field value.</li>
 *   <li>$max - Only updates the field if the specified value is greater than the existing field value.</li>
 *   <li>$currentDate - Sets the value of a field to current date as a Unix Epoch.</li>
 * </ul>
 * <br/>
 * Array Operators:<br/>
 * <ul>
 *   <li>$addToSet - Adds elements to an array only if they do not already exist in the set.</li>
 *   <li>$pop - Removes the first or last item of an array.</li>
 *   <li>$push - Adds an item to an array.</li>
 * </ul>
 * <br/>
 * Note: Performing multiple operations on the same field may yield unexpected results.<br/>
 *
 * @example <caption>Increment the property "counter" by 1 in the document where id = "foo".</caption>
 * updateSproc("foo", {$inc: {counter: 1}});
 *
 * @example <caption>Set the property "message" to "Hello World" and the "messageDate" to the current date in the document where id = "bar".</caption>
 * updateSproc("bar", {$set: {message: "Hello World"}, $currentDate: {messageDate: ""}});
 *
 * @function
 * @param {string} draftId - The draft id for your document.
 * @param {string} documentId - The id for your document.
 * @param {string} rootId - The id for the root document.
 * @param {string} previousVersion - The previous version of the document root.
 * @param {string} version - The current version of the document root.
 * @param {object} update - the modifications to apply.
 * @returns {bool} true if the document was updated with success.
 */
function updateSproc(draftId, documentId, rootId, subscriptionId, previousVersion, version, update, documentType, rootType) {
    var collection = getContext().getCollection();
    var collectionLink = collection.getSelfLink();
    var response = getContext().getResponse();

    // Validate input.
    if (!draftId) throw new Error("The id is undefined or null.");
    if (!documentId) throw new Error("The documentId is undefined or null.");
    if (!rootId) throw new Error("The rootId is undefined or null.");
    if (!subscriptionId) throw new Error("The subscriptionId is undefined or null.");
    if (!previousVersion) throw new Error("The previousVersion is undefined or null.");
    if (!version) throw new Error("The version is undefined or null.");
    if (!update) throw new Error("The update is undefined or null.");

    tryQueryAndUpdate();

    // Recursively queries for a document by id w/ support for continuation tokens.
    // Calls tryUpdate(document) as soon as the query returns a document.
    function tryQueryAndUpdate(continuation) {

        var query = {
            query: "select * from root r where r.draftId = @draftId and r.documentId = @documentId and r.subscriptionId = @subscriptionId",
            parameters: [{ name: "@draftId", value: draftId }, { name: "@documentId", value: documentId }, { name: "@subscriptionId", value: subscriptionId }]
        };

        if (documentType) {
            query = {
                query: "select * from root r where r.draftId = @draftId and r.documentId = @documentId and r.subscriptionId = @subscriptionId and r.documentType = @type",
                // query: "select * from root r where r.draftId = @draftId and r.documentId = @documentId and r.subscriptionId = @subscriptionId and r.document['$type'] = @type",
                parameters: [{ name: "@draftId", value: draftId }, { name: "@documentId", value: documentId }, { name: "@subscriptionId", value: subscriptionId }, { name: "@type", value: documentType }]
            };
        }

        var requestOptions = { continuation: continuation };

        var isAccepted = collection.queryDocuments(collectionLink, query, requestOptions, function (err, documents, responseOptions) {
            if (err) throw err;

            if (documents.length > 0) {

                if (rootId != documentId) {
                    // find master document
                    var query2 = {
                        query: "select * from root r where r.draftId = @draftId and r.documentId = @rootId and r.subscriptionId = @subscriptionId",
                        parameters: [{ name: "@draftId", value: draftId }, { name: "@rootId", value: rootId }, { name: "@subscriptionId", value: subscriptionId }]
                    };

                    if (rootType) {
                        query2 = {
                            query: "select * from root r where r.draftId = @draftId and r.documentId = @rootId and r.subscriptionId = @subscriptionId and r.documentType = @type",
                            // query: "select * from root r where r.draftId = @draftId and r.documentId = @rootId and r.subscriptionId = @subscriptionId and r.document['$type'] = @type",
                            parameters: [{ name: "@draftId", value: draftId }, { name: "@rootId", value: rootId }, { name: "@subscriptionId", value: subscriptionId }, { name: "@type", value: rootType }]
                        };
                    }

                    var requestOptions2 = { continuation: null };

                    var isAccepted2 = collection.queryDocuments(collectionLink, query2, requestOptions2, function (err2, documents2, responseOptions2) {
                        if (err) throw err;

                        if (documents2.length > 0) {
                            // If the document is found, update it.
                            // There is no need to check for a continuation token since we are querying for a single document.
                            tryUpdate(documents2[0], documents[0]);
                        }
                        else {
                            // Else a document with the given id does not exist..
                            throw new Error("Document not found.");
                        }
                    });
                }
                else {
                    // If the document is found, update it.
                    // There is no need to check for a continuation token since we are querying for a single document.
                    tryUpdate(documents[0], documents[0]);
                }
            } else if (responseOptions.continuation) {
                // Else if the query came back empty, but with a continuation token; repeat the query w/ the token.
                // It is highly unlikely for this to happen when performing a query by id; but is included to serve as an example for larger queries.
                tryQueryAndUpdate(responseOptions.continuation);
            } else {
                // Else a document with the given id does not exist.
                throw new Error("Document not found.");
            }
        });

        // If we hit execution bounds - throw an exception.
        // This is highly unlikely given that this is a query by id; but is included to serve as an example for larger queries.
        if (!isAccepted) {
            throw new Error("The stored procedure timed out.");
        }
    }

    // Updates the supplied document according to the update object passed in to the sproc.
    function tryUpdate(master, document) {

        // Check if the version is matches the original version
        if (previousVersion && master.version) {
            if (master.version != previousVersion) {
                throw new Error("Document version mismatch.");
            }
        }

        // DocumentDB supports optimistic concurrency control via HTTP ETag.
        var requestOptions = { etag: document._etag };

        // Update master and document to the new version (draft version control)
        master.version = version;
        master.document.version = version;
        document.version = version;
        document.document.version = version;

        // Update operators.
        set(document.document, update);

        //inc(document, update);
        //mul(document, update);
        //rename(document, update);
        //unset(document, update);
        //min(document, update);
        //max(document, update);
        //currentDate(document, update);
        //addToSet(document, update);
        //pop(document, update);
        //push(document, update);

        // Update the document.
        var isAccepted = collection.replaceDocument(document._self, document, requestOptions, function (err, updatedDocument, responseOptions) {
            if (err) throw err;

            // DocumentDB supports optimistic concurrency control via HTTP ETag.
            var requestOptions = { etag: master._etag };

            if (document.id != master.id) {
                // Update the master document (version)
                collection.replaceDocument(master._self, master, requestOptions, function (err, updatedDocument, responseOptions) {
                    if (err) throw err;

                    // If we have successfully updated the document and the master - return true in the response body.
                    response.setBody(true);
                });
            }
            else {
                // If we have successfully updated the document and the master - return true in the response body.
                response.setBody(true);
            }
        });

        // If we hit execution bounds - throw an exception.
        if (!isAccepted) {
            throw new Error("The stored procedure timed out.");
        }
    }

    // The $set operator sets the value of a field.
    function set(document, update) {
        var fields, i;

        if (update.$set) {
            fields = Object.keys(update.$set);
            for (i = 0; i < fields.length; i++) {
                var docProp = fetchFromObject(document, fields[i], update.$set[fields[i]]);
                if (!docProp) {
                    throw new Error("Bad $set parameter: The field path is not valid. " + fields[i] + " " + docProp);
                }
                //document[fields[i]] = update.$set[fields[i]];
            }
        }
    }

    function fetchFromObject(obj, prop, value) {
        if (typeof obj === 'undefined') {
            return false;
        }

        var _index = prop.indexOf('.')
        if (_index > -1) {
            return fetchFromObject(obj[prop.substring(0, _index)], prop.substr(_index + 1), value);
        }

        obj[prop] = value;
        return true;
    }

    // Operator implementations.
    // The $inc operator increments the value of a field by a specified amount.
    function inc(document, update) {
        var fields, i;

        if (update.$inc) {
            fields = Object.keys(update.$inc);
            for (i = 0; i < fields.length; i++) {
                if (isNaN(update.$inc[fields[i]])) {
                    // Validate the field; throw an exception if it is not a number (can't increment by NaN).
                    throw new Error("Bad $inc parameter - value must be a number")
                } else if (document[fields[i]]) {
                    // If the field exists, increment it by the given amount.
                    document[fields[i]] += update.$inc[fields[i]];
                } else {
                    // Otherwise set the field to the given amount.
                    document[fields[i]] = update.$inc[fields[i]];
                }
            }
        }
    }

    // The $mul operator multiplies the value of the field by the specified amount.
    function mul(document, update) {
        var fields, i;

        if (update.$mul) {
            fields = Object.keys(update.$mul);
            for (i = 0; i < fields.length; i++) {
                if (isNaN(update.$mul[fields[i]])) {
                    // Validate the field; throw an exception if it is not a number (can't multiply by NaN).
                    throw new Error("Bad $mul parameter - value must be a number")
                } else if (document[fields[i]]) {
                    // If the field exists, multiply it by the given amount.
                    document[fields[i]] *= update.$mul[fields[i]];
                } else {
                    // Otherwise set the field to 0.
                    document[fields[i]] = 0;
                }
            }
        }
    }

    //// The $rename operator renames a field.
    //function rename(document, update) {
    //    var fields, i, existingFieldName, newFieldName;

    //    if (update.$rename) {
    //        fields = Object.keys(update.$rename);
    //        for (i = 0; i < fields.length; i++) {
    //            existingFieldName = fields[i];
    //            newFieldName = update.$rename[fields[i]];

    //            if (existingFieldName == newFieldName) {
    //                throw new Error("Bad $rename parameter: The new field name must differ from the existing field name.")
    //            } else if (document[existingFieldName]) {
    //                // If the field exists, set/overwrite the new field name and unset the existing field name.
    //                document[newFieldName] = document[existingFieldName];
    //                delete document[existingFieldName];
    //            } else {
    //                // Otherwise this is a noop.
    //            }
    //        }
    //    }
    //}

    //// The $unset operator removes the specified field.
    //function unset(document, update) {
    //    var fields, i;

    //    if (update.$unset) {
    //        fields = Object.keys(update.$unset);
    //        for (i = 0; i < fields.length; i++) {
    //            delete document[fields[i]];
    //        }
    //    }
    //}

    //// The $min operator only updates the field if the specified value is less than the existing field value.
    //function min(document, update) {
    //    var fields, i;

    //    if (update.$min) {
    //        fields = Object.keys(update.$min);
    //        for (i = 0; i < fields.length; i++) {
    //            if (update.$min[fields[i]] < document[fields[i]]) {
    //                document[fields[i]] = update.$min[fields[i]];
    //            }
    //        }
    //    }
    //}

    //// The $max operator only updates the field if the specified value is greater than the existing field value.
    //function max(document, update) {
    //    var fields, i;

    //    if (update.$max) {
    //        fields = Object.keys(update.$max);
    //        for (i = 0; i < fields.length; i++) {
    //            if (update.$max[fields[i]] > document[fields[i]]) {
    //                document[fields[i]] = update.$max[fields[i]];
    //            }
    //        }
    //    }
    //}

    //// The $currentDate operator sets the value of a field to current date as a POSIX epoch.
    //function currentDate(document, update) {
    //    var currentDate = new Date();
    //    var fields, i;

    //    if (update.$currentDate) {
    //        fields = Object.keys(update.$currentDate);
    //        for (i = 0; i < fields.length; i++) {
    //            // ECMAScript's Date.getTime() returns milliseconds, where as POSIX epoch are in seconds.
    //            document[fields[i]] = Math.round(currentDate.getTime() / 1000);
    //        }
    //    }
    //}

    //// The $addToSet operator adds elements to an array only if they do not already exist in the set.
    //function addToSet(document, update) {
    //    var fields, i;

    //    if (update.$addToSet) {
    //        fields = Object.keys(update.$addToSet);

    //        for (i = 0; i < fields.length; i++) {
    //            if (!Array.isArray(document[fields[i]])) {
    //                // Validate the document field; throw an exception if it is not an array.
    //                throw new Error("Bad $addToSet parameter - field in document must be an array.")
    //            } else if (document[fields[i]].indexOf(update.$addToSet[fields[i]]) === -1) {
    //                // Add the element if it doesn't already exist in the array.
    //                document[fields[i]].push(update.$addToSet[fields[i]]);
    //            }
    //        }
    //    }
    //}

    //// The $pop operator removes the first or last item of an array.
    //// Pass $pop a value of -1 to remove the first element of an array and 1 to remove the last element in an array.
    //function pop(document, update) {
    //    var fields, i;

    //    if (update.$pop) {
    //        fields = Object.keys(update.$pop);

    //        for (i = 0; i < fields.length; i++) {
    //            if (!Array.isArray(document[fields[i]])) {
    //                // Validate the document field; throw an exception if it is not an array.
    //                throw new Error("Bad $pop parameter - field in document must be an array.")
    //            } else if (update.$pop[fields[i]] < 0) {
    //                // Remove the first element from the array if it's less than 0 (be flexible).
    //                document[fields[i]].shift();
    //            } else {
    //                // Otherwise, remove the last element from the array (have 0 default to javascript's pop()).
    //                document[fields[i]].pop();
    //            }
    //        }
    //    }
    //}

    //// The $push operator adds an item to an array.
    //function push(document, update) {
    //    var fields, i;

    //    if (update.$push) {
    //        fields = Object.keys(update.$push);

    //        for (i = 0; i < fields.length; i++) {
    //            if (!Array.isArray(document[fields[i]])) {
    //                // Validate the document field; throw an exception if it is not an array.
    //                throw new Error("Bad $push parameter - field in document must be an array.")
    //            } else {
    //                // Push the element in to the array.
    //                document[fields[i]].push(update.$push[fields[i]]);
    //            }
    //        }
    //    }
    //}
}
