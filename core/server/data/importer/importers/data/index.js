var _ = require('lodash'),
    Promise = require('bluebird'),
    semver = require('semver'),
    common = require('../../../../lib/common'),
    sequence = require('../../../../lib/promise/sequence'),
    models = require('../../../../models'),
    SubscribersImporter = require('./subscribers'),
    PostsImporter = require('./posts'),
    TagsImporter = require('./tags'),
    SettingsImporter = require('./settings'),
    UsersImporter = require('./users'),
    RolesImporter = require('./roles'),
    importers = {},
    DataImporter;

DataImporter = {
    type: 'data',

    preProcess: function preProcess(importData) {
        importData.preProcessedByData = true;
        return importData;
    },

    init: function init(importData) {
        importers.users = new UsersImporter(importData.data);
        importers.roles = new RolesImporter(importData.data);
        importers.tags = new TagsImporter(importData.data);
        importers.subscribers = new SubscribersImporter(importData.data);
        importers.posts = new PostsImporter(importData.data);
        importers.settings = new SettingsImporter(importData.data);

        return importData;
    },

    // Allow importing with an options object that is passed through the importer
    doImport: function doImport(importData, importOptions) {
        importOptions = importOptions || {};

        var ops = [], errors = [], results = [], modelOptions = {
            importing: true,
            context: {
                internal: true
            }
        };

        if (!importOptions.hasOwnProperty('returnImportedData')) {
            importOptions.returnImportedData = false;
        }

        if (importOptions.importPersistUser) {
            modelOptions.importPersistUser = importOptions.importPersistUser;
        }

        if (!importData.meta) {
            throw new common.errors.IncorrectUsageError({
                message: 'Wrong importer structure. `meta` is missing.',
                help: 'https://docs.ghost.org/docs/the-importer'
            });
        }

        if (!importData.meta.version) {
            throw new common.errors.IncorrectUsageError({
                message: 'Wrong importer structure. `meta.version` is missing.',
                help: 'https://docs.ghost.org/docs/the-importer'
            });
        }

        // CASE: We deny LTS imports (from 1.0 we use the Ghost version you are on)
        // @TODO: add migration guide link
        if (!semver.valid(importData.meta.version)) {
            return Promise.reject(new common.errors.InternalServerError({
                message: 'Importing a LTS export into Ghost 2.0 is not allowed.'
            }));
        }

        this.init(importData);

        return models.Base.transaction(function (transacting) {
            modelOptions.transacting = transacting;

            _.each(importers, function (importer) {
                ops.push(function doModelImport() {
                    return importer.fetchExisting(modelOptions, importOptions)
                        .then(function () {
                            return importer.beforeImport(modelOptions, importOptions);
                        })
                        .then(function () {
                            if (importer.options.requiredImportedData.length) {
                                _.each(importer.options.requiredImportedData, (key) => {
                                    importer.requiredImportedData[key] = importers[key].importedData;
                                });
                            }

                            if (importer.options.requiredExistingData.length) {
                                _.each(importer.options.requiredExistingData, (key) => {
                                    importer.requiredExistingData[key] = importers[key].existingData;
                                });
                            }

                            return importer.replaceIdentifiers(modelOptions, importOptions);
                        })
                        .then(function () {
                            return importer.doImport(modelOptions, importOptions)
                                .then(function (_results) {
                                    results = results.concat(_results);
                                });
                        });
                });
            });

            sequence(ops)
                .then(function () {
                    results.forEach(function (promise) {
                        if (!promise.isFulfilled()) {
                            errors = errors.concat(promise.reason());
                        }
                    });

                    if (errors.length === 0) {
                        transacting.commit();
                    } else {
                        transacting.rollback(errors);
                    }
                });
        }).then(function () {
            /**
             * data: imported data
             * originalData: data from the json file
             * problems: warnings
             */
            var toReturn = {
                data: {},
                originalData: importData.data,
                problems: []
            };

            _.each(importers, function (importer) {
                toReturn.problems = toReturn.problems.concat(importer.problems);

                if (importOptions.returnImportedData) {
                    toReturn.data[importer.dataKeyToImport] = importer.importedDataToReturn;
                }
            });

            return toReturn;
        }).catch(function (errors) {
            return Promise.reject(errors);
        });
    }
};

module.exports = DataImporter;
