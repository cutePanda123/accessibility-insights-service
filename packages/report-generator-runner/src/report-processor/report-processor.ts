// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { GlobalLogger } from 'logger';
import { TargetReport, OnDemandPageScanResult, WebsiteScanResult, ScanError, OnDemandPageScanRunState } from 'storage-documents';
import {
    OnDemandPageScanRunResultProvider,
    WebsiteScanResultProvider,
    ScanNotificationProcessor,
    RunnerScanMetadata,
    getOnMergeCallbackToUpdateRunResult,
} from 'service-library';
import { ServiceConfiguration, System } from 'common';
import { isString } from 'lodash';
import { QueuedRequest } from '../runner/request-selector';
import { AccessibilityReportProcessor } from './accessibility-report-processor';

export interface TargetReportProcessor {
    generate(pageScanResult: OnDemandPageScanResult, queuedRequest: QueuedRequest): Promise<QueuedRequest>;
}

@injectable()
export class ReportProcessor {
    constructor(
        @inject(OnDemandPageScanRunResultProvider) private readonly onDemandPageScanRunResultProvider: OnDemandPageScanRunResultProvider,
        @inject(WebsiteScanResultProvider) protected readonly websiteScanResultProvider: WebsiteScanResultProvider,
        @inject(ScanNotificationProcessor) protected readonly scanNotificationProcessor: ScanNotificationProcessor,
        @inject(AccessibilityReportProcessor) protected readonly accessibilityReportProcessor: AccessibilityReportProcessor,
        @inject(ServiceConfiguration) protected readonly serviceConfig: ServiceConfiguration,
        @inject(GlobalLogger) private readonly logger: GlobalLogger,
    ) {}

    public async generate(targetReport: TargetReport, queuedRequests: QueuedRequest[]): Promise<QueuedRequest[]> {
        const processedRequests = [];
        // processing in sequence to avoid collision
        for (const queuedRequest of queuedRequests) {
            let processedRequest: QueuedRequest;
            if (targetReport === 'accessibility') {
                processedRequest = await this.generateReport(this.accessibilityReportProcessor, queuedRequest);
            } else {
                processedRequest = {
                    ...queuedRequest,
                    condition: 'failed',
                    error: `The '${targetReport}' report is not supported. Report group id: ${queuedRequest.request.scanGroupId}`,
                } as QueuedRequest;
            }

            processedRequests.push(processedRequest);
        }

        return processedRequests;
    }

    private async generateReport(targetReportProcessor: TargetReportProcessor, queuedRequest: QueuedRequest): Promise<QueuedRequest> {
        let pageScanResult: OnDemandPageScanResult;
        try {
            this.logger.logInfo(`Generating accessibility consolidated report.`, {
                scanId: queuedRequest.request.scanId,
                scanGroupId: queuedRequest.request.scanGroupId,
            });

            pageScanResult = await this.onDemandPageScanRunResultProvider.readScanRun(queuedRequest.request.scanId);
            await targetReportProcessor.generate(pageScanResult, queuedRequest);

            this.setRunResult(pageScanResult, 'completed');
            queuedRequest.condition = 'completed';
            this.logger.logInfo(`The accessibility consolidated report generated successfully.`, {
                scanId: queuedRequest.request.scanId,
                scanGroupId: queuedRequest.request.scanGroupId,
            });
        } catch (error) {
            const errorMessage = System.serializeError(error);
            if (pageScanResult) {
                this.setRunResult(pageScanResult, 'failed', errorMessage);
            }
            queuedRequest.condition = 'failed';
            queuedRequest.error = errorMessage;
            this.logger.logError(`The consolidated report generation has failed.`, {
                error: errorMessage,
                scanId: queuedRequest.request.scanId,
                scanGroupId: queuedRequest.request.scanGroupId,
            });
        }

        if (pageScanResult) {
            const websiteScanResult = await this.updateScanResult(pageScanResult);
            const runnerScanMetadata: RunnerScanMetadata = {
                id: pageScanResult.id,
                url: pageScanResult.url,
                deepScan: websiteScanResult?.deepScanId !== undefined ? true : false,
            };
            // the scan notification processor will detect if notification should be sent
            await this.scanNotificationProcessor.sendScanCompletionNotification(runnerScanMetadata, pageScanResult, websiteScanResult);
        }

        return queuedRequest;
    }

    private async updateScanResult(pageScanResult: Partial<OnDemandPageScanResult>): Promise<WebsiteScanResult> {
        await this.onDemandPageScanRunResultProvider.updateScanRun(pageScanResult);

        // deep-scan request type requires update of website scan result
        const websiteScanRef = pageScanResult.websiteScanRefs?.find((ref) => ref.scanGroupType === 'deep-scan');
        if (websiteScanRef) {
            const scanConfig = await this.serviceConfig.getConfigValue('scanConfig');
            const runState =
                pageScanResult.run.state === 'completed' || pageScanResult.run.retryCount >= scanConfig.maxFailedScanRetryCount
                    ? pageScanResult.run.state
                    : undefined;

            const updatedWebsiteScanResult: Partial<WebsiteScanResult> = {
                id: websiteScanRef.id,
                pageScans: [
                    {
                        scanId: pageScanResult.id,
                        url: pageScanResult.url,
                        scanState: pageScanResult.scanResult?.state,
                        runState,
                        timestamp: new Date().toJSON(),
                    },
                ],
            };
            const onMergeCallbackFn = getOnMergeCallbackToUpdateRunResult(runState);

            return this.websiteScanResultProvider.mergeOrCreate(pageScanResult.id, updatedWebsiteScanResult, onMergeCallbackFn);
        }

        return undefined;
    }

    private setRunResult(pageScanResult: OnDemandPageScanResult, state: OnDemandPageScanRunState, error?: string | ScanError): void {
        pageScanResult.run = {
            ...pageScanResult.run,
            state,
            timestamp: new Date().toJSON(),
            error: isString(error) ? error.substring(0, 2048) : error,
        };
    }
}
