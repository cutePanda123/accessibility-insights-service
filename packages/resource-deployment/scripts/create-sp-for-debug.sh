#!/bin/bash

# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

set -eo pipefail

# The script will create a service principal and configure its access to Azure resources under resource group and key vault
# The script can be run multiple times that result the same service principal entity but with password reset

export subscription
export resourceGroupName
export keyVault

export clientId
export tenant
export password

exitWithUsageInfo() {
    echo "
Usage: $0 -r <resource group> -s <subscription name or id> -k <key vault>
"
    exit 1
}

# Read script arguments
while getopts ":s:r:k:" option; do
    case $option in
    s) subscription=${OPTARG} ;;
    r) resourceGroupName=${OPTARG} ;;
    k) keyVault=${OPTARG} ;;
    *) exitWithUsageInfo ;;
    esac
done

if [[ -z $subscription ]] || [[ -z $resourceGroupName ]] || [[ -z $keyVault ]]; then
    exitWithUsageInfo
fi

# Login to Azure if required
if ! az account show 1>/dev/null; then
    az login
fi

# Set default subscription scope
az account set --subscription "$subscription"

# Generate service principal name
user=$(az ad signed-in-user show --query "mailNickname" -o tsv)
displayName="$user-$resourceGroupName"

# Create or update service principal object
# Use display name instead of service principal name to prevent az cli assiging a random display name
echo "Creating service principal..."
password=$(az ad sp create-for-rbac --role contributor --scopes "/subscriptions/$subscription/resourceGroups/$resourceGroupName" --name "$displayName" --query "password" -o tsv)

# Retrieve service principal object properties
tenant=$(az ad sp list --display-name "${displayName}" --query "[0].appOwnerTenantId" -o tsv)
clientId=$(az ad sp list --display-name "${displayName}" --query "[0].appId" -o tsv)
objectId=$(az ad sp list --display-name "${displayName}" --query "[0].objectId" -o tsv)

# Set key vault access policy
echo "Granting service principal permissions to the '$keyVault' key vault"
az keyvault set-policy --name "${keyVault}" --object-id "${objectId}" --secret-permissions get list 1>/dev/null

# Granting access to storage blob
echo "Granting service principal permissions to the '$storageAccountName' Blob storage"
az role assignment create --role "Storage Blob Data Contributor" --assignee "$clientId" --scope "/subscriptions/$subscription/resourceGroups/$resourceGroupName/providers/Microsoft.Storage/storageAccounts/$storageAccountName" 1>/dev/null

# Granting access to storage queue
echo "Granting service principal permissions to the '$storageAccountName' Queue storage"
az role assignment create --role "Storage Queue Data Contributor" --assignee "$clientId" --scope "/subscriptions/$subscription/resourceGroups/$resourceGroupName/providers/Microsoft.Storage/storageAccounts/$storageAccountName" 1>/dev/null
