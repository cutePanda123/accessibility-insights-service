// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { GuidGenerator, ServiceConfiguration } from 'common';
import { inject, injectable } from 'inversify';
import { isEmpty } from 'lodash';
import { ContextAwareLogger } from 'logger';
import { HttpResponse, OnDemandPageScanRunResultProvider, WebApiErrorCodes, WebsiteScanResultProvider } from 'service-library';
import { ScanResponseConverter } from '../converters/scan-response-converter';
import { BaseScanResultController } from './base-scan-result-controller';

@injectable()
export class ScanResultController extends BaseScanResultController {
    public readonly apiVersion = '1.0';

    public readonly apiName = 'web-api-get-scan';

    public constructor(
        @inject(OnDemandPageScanRunResultProvider) protected readonly onDemandPageScanRunResultProvider: OnDemandPageScanRunResultProvider,
        @inject(WebsiteScanResultProvider) protected readonly websiteScanResultProvider: WebsiteScanResultProvider,
        @inject(ScanResponseConverter) protected readonly scanResponseConverter: ScanResponseConverter,
        @inject(GuidGenerator) protected readonly guidGenerator: GuidGenerator,
        @inject(ServiceConfiguration) protected readonly serviceConfig: ServiceConfiguration,
        @inject(ContextAwareLogger) logger: ContextAwareLogger,
    ) {
        super(logger);
    }

    public async handleRequest(): Promise<void> {
        const scanId = <string>this.context.bindingData.scanId;
        this.logger.setCommonProperties({ source: 'getScanResultRESTApi', scanId });

        if (!this.isScanIdValid(scanId)) {
            this.context.res = HttpResponse.getErrorResponse(WebApiErrorCodes.invalidResourceId);
            this.logger.logError('The client request scan id is malformed.');

            return;
        }

        const scanResultItemMap = await this.getScanResultMapKeyByScanId([scanId]);
        const pageScanResult = scanResultItemMap[scanId];

        if (isEmpty(pageScanResult)) {
            // scan result not found in result storage
            if (await this.isRequestMadeTooSoon(scanId)) {
                // user made the scan result query too soon after the scan request, will return a default pending response.
                this.context.res = {
                    status: 200,
                    body: this.getTooSoonRequestResponse(scanId),
                };
                this.logger.logInfo('Scan result is not ready in a storage.');
            } else {
                // return scan not found response
                this.context.res = HttpResponse.getErrorResponse(WebApiErrorCodes.resourceNotFound);
                this.logger.logInfo('Scan result not found in a storage.');
            }
        } else {
            const websiteScanResult = await this.getWebsiteScanResult(pageScanResult);
            const body = await this.getScanResultResponse(pageScanResult, websiteScanResult);
            this.context.res = {
                status: 200,
                body,
            };
            this.logger.logInfo('Scan result successfully fetched from a storage.');
        }
    }
}
