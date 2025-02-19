// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import 'reflect-metadata';

import { Context } from '@azure/functions';
import { GuidGenerator, RestApiConfig, ServiceConfiguration, CrawlConfig } from 'common';
import { ScanRequestReceivedMeasurements } from 'logger';
import { HttpResponse, ScanDataProvider, ScanRunResponse, WebApiErrorCodes } from 'service-library';
import { ScanRunBatchRequest, PrivacyScan } from 'storage-documents';
import { IMock, It, Mock, Times } from 'typemoq';
import { MockableLogger } from '../test-utilities/mockable-logger';

import { ScanRequestController } from './scan-request-controller';

/* eslint-disable @typescript-eslint/consistent-type-assertions */

interface DataItem {
    url: string;
}

describe(ScanRequestController, () => {
    let scanRequestController: ScanRequestController;
    let context: Context;
    let scanDataProviderMock: IMock<ScanDataProvider>;
    let serviceConfigurationMock: IMock<ServiceConfiguration>;
    let loggerMock: IMock<MockableLogger>;
    let guidGeneratorMock: IMock<GuidGenerator>;

    beforeEach(() => {
        context = <Context>(<unknown>{
            req: {
                method: 'POST',
                rawBody: `{ url: 'https://abc/path/' }`,
                headers: {},
                query: {},
            },
        });
        context.req.query['api-version'] = '1.0';
        context.req.headers['content-type'] = 'application/json';

        scanDataProviderMock = Mock.ofType<ScanDataProvider>();
        scanDataProviderMock.setup(async (o) => o.writeScanRunBatchRequest(It.isAny(), It.isAny()));

        guidGeneratorMock = Mock.ofType(GuidGenerator);

        serviceConfigurationMock = Mock.ofType<ServiceConfiguration>();
        serviceConfigurationMock
            .setup(async (s) => s.getConfigValue('restApiConfig'))
            .returns(async () => {
                return {
                    maxScanRequestBatchCount: 4,
                    minScanPriorityValue: -10,
                    maxScanPriorityValue: 10,
                } as RestApiConfig;
            });
        serviceConfigurationMock
            .setup(async (s) => s.getConfigValue('crawlConfig'))
            .returns(async () => {
                return {
                    deepScanUpperLimit: 2,
                } as CrawlConfig;
            });

        loggerMock = Mock.ofType<MockableLogger>();
    });

    function createScanRequestController(contextReq: Context): ScanRequestController {
        const controller = new ScanRequestController(
            scanDataProviderMock.object,
            guidGeneratorMock.object,
            serviceConfigurationMock.object,
            loggerMock.object,
        );
        controller.context = contextReq;

        return controller;
    }

    function sortData<T extends DataItem>(array: T[]): T[] {
        return array.sort((a, b) => (a.url > b.url ? 1 : b.url > a.url ? -1 : 0));
    }

    describe(ScanRequestController, () => {
        it('rejects request with large payload', async () => {
            context.req.rawBody = JSON.stringify([{ url: '' }, { url: '' }, { url: '' }, { url: '' }, { url: '' }]);
            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res).toEqual(HttpResponse.getErrorResponse(WebApiErrorCodes.requestBodyTooLarge));
        });

        it('rejects request with invalid scan notify url', async () => {
            context.req.rawBody = JSON.stringify([{ url: 'https://abc/path/', scanNotifyUrl: 'invalid-url' }]);
            scanRequestController = createScanRequestController(context);
            const expectedResponse = [{ url: 'https://abc/path/', error: WebApiErrorCodes.invalidScanNotifyUrl.error }];

            await scanRequestController.handleRequest();

            expect(context.res.body).toEqual(expectedResponse);
        });

        it('rejects request with invalid base url', async () => {
            context.req.rawBody = JSON.stringify([
                {
                    url: 'https://abc/path/',
                    site: { baseUrl: 'invalid-url' },
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                },
            ]);
            scanRequestController = createScanRequestController(context);
            const expectedResponse = [{ url: 'https://abc/path/', error: WebApiErrorCodes.invalidURL.error }];

            await scanRequestController.handleRequest();

            expect(context.res.body).toEqual(expectedResponse);
        });

        it("rejects request with incomplete 'site' or 'reportGroups' property", async () => {
            context.req.rawBody = JSON.stringify([
                {
                    url: 'https://abc/path/',
                    site: { baseUrl: 'https://base/path' },
                    reportGroups: [{ consolidatedId: undefined }, { consolidatedId: 'reportGroupId' }], // empty id
                },
                {
                    url: 'https://def/path/',
                    site: 'https://base/path', // invalid site object
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                },
                {
                    // missing site
                    url: 'https://hij/path/',
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                },
                {
                    // missing reportGroups
                    url: 'https://klm/path/',
                    site: { baseUrl: 'https://base/path' },
                },
            ]);

            const expectedResponse = [
                { url: 'https://abc/path/', error: WebApiErrorCodes.missingSiteOrReportGroups.error },
                { url: 'https://def/path/', error: WebApiErrorCodes.missingSiteOrReportGroups.error },
                { url: 'https://hij/path/', error: WebApiErrorCodes.missingSiteOrReportGroups.error },
                { url: 'https://klm/path/', error: WebApiErrorCodes.missingSiteOrReportGroups.error },
            ];

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            // normalize random result order
            const expectedResponseSorted = sortData(expectedResponse);
            const responseSorted = sortData(<ScanRunResponse[]>(<unknown>context.res.body));

            expect(responseSorted).toEqual(expectedResponseSorted);
        });

        it('rejects deepScan requests if they are missing required properties', async () => {
            context.req.rawBody = JSON.stringify([
                {
                    // missing both site and reportGroups
                    deepScan: true,
                    url: 'https://abc/path/',
                },
                {
                    // missing site
                    deepScan: true,
                    url: 'https://def/path/',
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                },
                {
                    // missing reportGroups
                    deepScan: true,
                    url: 'https://hij/path/',
                    site: { baseUrl: 'https://base/path' },
                },
            ]);

            const expectedResponse = [
                { url: 'https://abc/path/', error: WebApiErrorCodes.missingRequiredDeepScanProperties.error },
                { url: 'https://def/path/', error: WebApiErrorCodes.missingRequiredDeepScanProperties.error },
                { url: 'https://hij/path/', error: WebApiErrorCodes.missingRequiredDeepScanProperties.error },
            ];

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            // normalize random result order
            const expectedResponseSorted = sortData(expectedResponse);
            const responseSorted = sortData(<ScanRunResponse[]>(<unknown>context.res.body));

            expect(responseSorted).toEqual(expectedResponseSorted);
        });

        it('rejects deepScan requests if they are too many known pages', async () => {
            context.req.rawBody = JSON.stringify([
                {
                    // too many known pages
                    deepScan: true,
                    url: 'https://base/path/',
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                    site: {
                        baseUrl: 'https://base/path',
                        knownPages: ['https://base/path/p1', 'https://base/path/p2', 'https://base/path/p3'],
                    },
                },
            ]);
            const expectedResponse = [{ url: 'https://base/path/', error: WebApiErrorCodes.tooManyKnownPages.error }];

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.body).toEqual(expectedResponse);
        });

        it('rejects deepScan requests if there is invalid known page URL', async () => {
            context.req.rawBody = JSON.stringify([
                {
                    // invalid known page URL
                    deepScan: true,
                    url: 'https://base/path/',
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                    site: {
                        baseUrl: 'https://base/path',
                        knownPages: ['https://base/path/p1', 'invalid " url'],
                    },
                },
            ]);
            const expectedResponse = [{ url: 'https://base/path/', error: WebApiErrorCodes.invalidKnownPageURL.error }];

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.body).toEqual(expectedResponse);
        });

        // it('rejects deepScan requests if there is duplicate known page URL', async () => {
        //     context.req.rawBody = JSON.stringify([
        //         {
        //             // duplicate known page URL
        //             deepScan: true,
        //             url: 'https://base/path/',
        //             reportGroups: [{ consolidatedId: 'reportGroupId' }],
        //             site: {
        //                 baseUrl: 'https://base/path',
        //                 knownPages: ['https://base/path/p1', 'https://base/path/p1/#top'],
        //             },
        //         },
        //     ]);
        //     const expectedResponse = [{ url: 'https://base/path/', error: WebApiErrorCodes.duplicateKnownPage.error }];

        //     scanRequestController = createScanRequestController(context);

        //     await scanRequestController.handleRequest();

        //     expect(context.res.body).toEqual(expectedResponse);
        // });

        // it('rejects deepScan requests if there is duplicate base URL in known pages list', async () => {
        //     context.req.rawBody = JSON.stringify([
        //         {
        //             // duplicate known page URL
        //             deepScan: true,
        //             url: 'https://base/path/',
        //             reportGroups: [{ consolidatedId: 'reportGroupId' }],
        //             site: {
        //                 baseUrl: 'https://base/path',
        //                 knownPages: ['https://base/path/p1', 'https://base/path/'],
        //             },
        //         },
        //     ]);
        //     const expectedResponse = [{ url: 'https://base/path/', error: WebApiErrorCodes.duplicateKnownPage.error }];

        //     scanRequestController = createScanRequestController(context);

        //     await scanRequestController.handleRequest();

        //     expect(context.res.body).toEqual(expectedResponse);
        // });

        it('accepts valid request only', async () => {
            const guid1 = '1e9cefa6-538a-6df0-aaaa-ffffffffffff';
            const guid2 = '1e9cefa6-538a-6df0-bbbb-ffffffffffff';
            guidGeneratorMock.setup((g) => g.createGuid()).returns(() => guid1);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid2);

            context.req.rawBody = JSON.stringify([
                {
                    url: 'https://abs/path/',
                    priority: 1,
                    scanNotifyUrl: 'https://notify/path/',
                    site: {
                        baseUrl: 'https://base/path',
                        knownPages: ['https://base/path/known1', 'https://base/path/known2'],
                        discoveryPatterns: ['pattern1', 'pattern2'],
                    },
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                    deepScan: true,
                }, // valid request
                { url: '/invalid/url' }, // invalid URL
                { url: 'https://cde/path/', priority: 9999 }, // invalid priority range
            ]);
            const expectedResponse = [
                { scanId: guid2, url: 'https://abs/path/' },
                { url: '/invalid/url', error: WebApiErrorCodes.invalidURL.error },
                { url: 'https://cde/path/', error: WebApiErrorCodes.outOfRangePriority.error },
            ];
            const expectedSavedRequest: ScanRunBatchRequest[] = [
                {
                    scanId: guid2,
                    url: 'https://abs/path/',
                    priority: 1,
                    scanNotifyUrl: 'https://notify/path/',
                    site: {
                        baseUrl: 'https://base/path',
                        knownPages: ['https://base/path/known1', 'https://base/path/known2'],
                        discoveryPatterns: ['pattern1', 'pattern2'],
                    },
                    reportGroups: [{ consolidatedId: 'reportGroupId' }],
                    deepScan: true,
                },
            ];
            scanDataProviderMock.setup(async (o) => o.writeScanRunBatchRequest(guid1, expectedSavedRequest)).verifiable(Times.once());

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            // normalize random result order
            const expectedResponseSorted = sortData(expectedResponse);
            const responseSorted = sortData(<ScanRunResponse[]>(<unknown>context.res.body));

            expect(context.res.status).toEqual(202);
            expect(responseSorted).toEqual(expectedResponseSorted);
            scanDataProviderMock.verifyAll();
            guidGeneratorMock.verifyAll();
        });

        it('accepts request with priority', async () => {
            const guid1 = '1e9cefa6-538a-6df0-aaaa-ffffffffffff';
            const guid2 = '1e9cefa6-538a-6df0-bbbb-ffffffffffff';
            guidGeneratorMock.setup((g) => g.createGuid()).returns(() => guid1);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid2);
            const priority = 10;

            context.req.rawBody = JSON.stringify([{ url: 'https://abs/path/', priority: priority }]);
            const expectedResponse = [{ scanId: guid2, url: 'https://abs/path/' }];
            const expectedSavedRequest: ScanRunBatchRequest[] = [{ scanId: guid2, url: 'https://abs/path/', priority: priority }];
            scanDataProviderMock.setup(async (o) => o.writeScanRunBatchRequest(guid1, expectedSavedRequest)).verifiable(Times.once());

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.status).toEqual(202);
            expect(context.res.body).toEqual(expectedResponse);
            scanDataProviderMock.verifyAll();
            guidGeneratorMock.verifyAll();
        });

        it.each([{ cookieBannerType: 'standard' }, undefined])('accepts request with privacyScan=%s', async (privacyScan: PrivacyScan) => {
            const guid1 = '1e9cefa6-538a-6df0-aaaa-ffffffffffff';
            const guid2 = '1e9cefa6-538a-6df0-bbbb-ffffffffffff';
            guidGeneratorMock.setup((g) => g.createGuid()).returns(() => guid1);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid2);

            context.req.rawBody = JSON.stringify([{ url: 'https://abs/path/', privacyScan }]);
            const expectedResponse = [{ scanId: guid2, url: 'https://abs/path/' }];
            const expectedSavedRequest: ScanRunBatchRequest[] = privacyScan
                ? [{ scanId: guid2, url: 'https://abs/path/', priority: 0, privacyScan }]
                : [{ scanId: guid2, url: 'https://abs/path/', priority: 0 }];
            scanDataProviderMock.setup(async (o) => o.writeScanRunBatchRequest(guid1, expectedSavedRequest)).verifiable(Times.once());

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.status).toEqual(202);
            expect(context.res.body).toEqual(expectedResponse);
            scanDataProviderMock.verifyAll();
            guidGeneratorMock.verifyAll();
        });

        it('sends telemetry event', async () => {
            const guid1 = '1e9cefa6-538a-6df0-aaaa-ffffffffffff';
            const guid2 = '1e9cefa6-538a-6df0-bbbb-ffffffffffff';
            guidGeneratorMock.setup((g) => g.createGuid()).returns(() => guid1);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid2);

            context.req.rawBody = JSON.stringify([
                { url: 'https://abs/path/', priority: 1 }, // valid request
                { url: '/invalid/url' }, // invalid URL
                { url: 'https://cde/path/', priority: 9999 }, // invalid priority range
            ]);

            const expectedMeasurements: ScanRequestReceivedMeasurements = {
                totalScanRequests: 3,
                pendingScanRequests: 1,
                rejectedScanRequests: 2,
            };

            loggerMock.setup((lm) => lm.trackEvent('ScanRequestReceived', null, expectedMeasurements)).verifiable();

            scanRequestController = createScanRequestController(context);
            await scanRequestController.handleRequest();

            loggerMock.verifyAll();
        });

        it('v1.0 accepts an array', async () => {
            const guid1 = '1e9cefa6-538a-6df0-aaaa-ffffffffffff';
            const guid2 = '1e9cefa6-538a-6df0-bbbb-ffffffffffff';
            const guid3 = '1e9cefa6-538a-6df0-dddd-ffffffffffff';

            guidGeneratorMock.setup((g) => g.createGuid()).returns(() => guid1);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid2);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid3);

            const priority = 10;

            context.req.rawBody = JSON.stringify([
                { url: 'https://abs/path/', priority: priority },
                { url: 'https://bing.com/path/', priority: priority },
            ]);
            const expectedResponse = [
                { scanId: guid2, url: 'https://abs/path/' },
                { scanId: guid3, url: 'https://bing.com/path/' },
            ];

            const expectedSaveRequest: ScanRunBatchRequest[] = [
                { scanId: guid2, url: 'https://abs/path/', priority: priority },
                { scanId: guid3, url: 'https://bing.com/path/', priority: priority },
            ];
            scanDataProviderMock.setup(async (o) => o.writeScanRunBatchRequest(guid1, expectedSaveRequest)).verifiable(Times.once());

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.status).toEqual(202);
            expect(context.res.body).toEqual(expectedResponse);
            scanDataProviderMock.verifyAll();
            guidGeneratorMock.verifyAll();
        });

        it('v2.0 accepts a single url', async () => {
            const guid1 = '1e9cefa6-538a-6df0-aaaa-ffffffffffff';
            const guid2 = '1e9cefa6-538a-6df0-bbbb-ffffffffffff';

            context.req.query['api-version'] = '2.0';

            guidGeneratorMock.setup((g) => g.createGuid()).returns(() => guid1);
            guidGeneratorMock.setup((g) => g.createGuidFromBaseGuid(guid1)).returns(() => guid2);

            const priority = 10;

            context.req.rawBody = JSON.stringify({ url: 'https://abs/path/', priority: priority });
            const expectedResponse = { scanId: guid2, url: 'https://abs/path/' };

            const expectedSaveRequest: ScanRunBatchRequest[] = [{ scanId: guid2, url: 'https://abs/path/', priority: priority }];
            scanDataProviderMock.setup(async (o) => o.writeScanRunBatchRequest(guid1, expectedSaveRequest)).verifiable(Times.once());

            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.status).toEqual(202);
            expect(context.res.body).toEqual(expectedResponse);
            scanDataProviderMock.verifyAll();
            guidGeneratorMock.verifyAll();
        });

        it('v2.0 accepts does not accept an array', async () => {
            context.req.query['api-version'] = '2.0';
            const priority = 10;

            context.req.rawBody = JSON.stringify([{ url: 'https://abs/path/', priority: priority }]);
            scanRequestController = createScanRequestController(context);

            await scanRequestController.handleRequest();

            expect(context.res.status).toEqual(400);
            expect(context.res).toEqual(HttpResponse.getErrorResponse(WebApiErrorCodes.malformedRequest));
        });
    });
});
