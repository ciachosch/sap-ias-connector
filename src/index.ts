import {
    Context,
    createConnector,
    readConfig,
    Response,
    logger,
    ConnectorError,
    StdAccountListOutput,
    StdAccountReadInput,
    StdAccountReadOutput,
    StdTestConnectionOutput,
    StdAccountListInput,
    StdTestConnectionInput,
    StdAccountCreateInput,
    StdAccountCreateOutput,
    StdAccountEnableInput,
    StdAccountEnableOutput,
    StdAccountDisableInput,
    StdAccountDisableOutput,
    StdAccountDeleteInput,
    StdAccountDeleteOutput,
    StdAccountUpdateInput,
    StdAccountUpdateOutput,
    StdEntitlementListInput,
    StdEntitlementListOutput,
} from '@sailpoint/connector-sdk'
import { MyClient } from './my-client'

const SAP_EXTENSION = 'urn:ietf:params:scim:schemas:extension:sap:2.0:User'
const ENTERPRISE_EXTENSION = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
// SAP custom extension — holds e.g. customAttribute7 (manager id / group id)
const CUSTOM_EXTENSION = 'urn:sap:cloud:scim:schemas:extension:custom:2.0:User'
// PAG-specific (carisma) extension — Porsche-owned attributes (KIRA replacement)
const CARISMA_EXTENSION = 'urn:pag:cloud:scim:schemas:extension:carisma:2.0:User'
const SAP_GROUP_CUSTOM_EXT = 'urn:sap:cloud:scim:schemas:extension:custom:2.0:Group'
const SAP_GROUP_EXT = 'urn:ietf:params:scim:schemas:extension:sap:2.0:Group'

const getCustomAttr = (ext: any, name: string): string | undefined => {
    if (!ext) return undefined
    if (ext[name] != null) return ext[name]
    if (Array.isArray(ext.attributes)) {
        const entry = ext.attributes.find((a: any) => a.name === name)
        return entry?.value
    }
    return undefined
}

export const toAccountOutput = (scimUser: any): StdAccountListOutput & StdAccountReadOutput => {
    const identity = scimUser.userName || scimUser.id
    if (!identity) {
        throw new ConnectorError('User has no userName or id — skipping')
    }
    const sapExt = scimUser[SAP_EXTENSION]
    const entExt = scimUser[ENTERPRISE_EXTENSION]
    const customExt = scimUser[CUSTOM_EXTENSION]
    const carismaExt = scimUser[CARISMA_EXTENSION]
    return {
        identity,
        uuid: scimUser.id,
        // Report account enable/disable status to ISC. Without this ISC treats every
        // account as enabled, so a lifecycle disable/enable never shows up in ISC.
        disabled: scimUser.active === false,
        attributes: {
            userName: scimUser.userName || identity,
            givenName: scimUser.name?.givenName,
            familyName: scimUser.name?.familyName,
            id: scimUser.id,
            email: scimUser.emails?.find((e: any) => e.primary || e.type === 'work')?.value,
            externalEmail: scimUser.emails?.find((e: any) => e.type === 'other')?.value,
            active: scimUser.active,
            locked: !scimUser.active,
            sapUserId: sapExt?.userId,
            sapUserUuid: sapExt?.userUuid,
            loginName: sapExt?.loginName,
            displayName: scimUser.displayName,
            userType: scimUser.userType,
            language: scimUser.preferredLanguage,
            timezone: scimUser.timezone,
            phoneNumber: scimUser.phoneNumbers?.find((p: any) => p.type === 'work')?.value,
            costCenter: entExt?.costCenter,
            division: entExt?.division,
            employeeNumber: entExt?.employeeNumber,
            organization: entExt?.organization,
            // Manager lives in the SAP custom extension (customAttribute7), NOT enterprise
            manager: getCustomAttr(customExt, 'customAttribute7') ?? null,
            validFrom: sapExt?.validFrom,
            validTo: sapExt?.validTo,
            country: scimUser.addresses?.[0]?.country,
            isEmailVerified: scimUser.emails?.[0]?.verified,
            // PAG carisma extension attributes
            vwgPersonenStatus: carismaExt?.vwgPersonStatus,
            companyCode: carismaExt?.companyCode,
            mgmtLevel: carismaExt?.mgmtLevel,
            vwgResponsible: carismaExt?.vwgResponsible,
            ntprimaryUserAccount: carismaExt?.ntprimaryUserAccount,
            cisoLiso: carismaExt?.CisoLiso,
            vwgCommunity: carismaExt?.vwgCommunity,
            groups: scimUser.groups?.map((g: any) => g.value) ?? [],
        },
    }
}

export const toEntitlementOutput = (scimGroup: any): StdEntitlementListOutput => {
    const customExt = scimGroup[SAP_GROUP_CUSTOM_EXT]
    const sapExt = scimGroup[SAP_GROUP_EXT]
    return {
        identity: scimGroup.id,
        uuid: scimGroup.id,
        type: 'group',
        attributes: {
            id: scimGroup.id,
            displayName: scimGroup.displayName,
            name: customExt?.name,
            description: customExt?.description,
            type: sapExt?.type,
            applicationId: sapExt?.applicationId,
        },
    }
}

// Connector must be exported as module property named connector
export const connector = async () => {

    // Get connector source config
    const config = await readConfig()

    // Use the vendor SDK, or implement own client as necessary, to initialize a client
    const myClient = new MyClient(config)

    return createConnector()
        .stdTestConnection(async (context: Context, input: StdTestConnectionInput, res: Response<StdTestConnectionOutput>) => {
            logger.info('Running test connection')
            res.send(await myClient.testConnection())
        })
        .stdAccountList(async (context: Context, input: StdAccountListInput, res: Response<StdAccountListOutput>) => {
            // Stream page-by-page so large sources (tens of thousands of accounts) don't
            // buffer everything in memory before sending.
            const sent = await myClient.streamAccounts((batch) => {
                for (const account of batch) {
                    res.send(toAccountOutput(account))
                }
            })
            logger.info(`stdAccountList sent ${sent} accounts`)
        })
        .stdAccountRead(async (context: Context, input: StdAccountReadInput, res: Response<StdAccountReadOutput>) => {
            const account = await myClient.getAccount(input.identity)

            res.send(toAccountOutput(account))
            logger.info(`stdAccountRead read account: ${input.identity}`)
        })
        .stdAccountCreate(async (context: Context, input: StdAccountCreateInput, res: Response<StdAccountCreateOutput>) => {
            const attrs = { ...input.attributes }
            if (input.identity && !attrs.userName) attrs.userName = input.identity

            const groupIds: string[] = Array.isArray(attrs.groups) ? attrs.groups : attrs.groups ? [attrs.groups] : []
            delete attrs.groups

            const account = await myClient.createAccount(attrs)

            // SAP IAS manages group membership on the Group resource, not the User
            for (const groupId of groupIds) {
                await myClient.modifyGroupMembership(groupId, account.id, 'add')
                logger.info(`stdAccountCreate added user ${account.id} to group ${groupId}`)
            }

            const freshAccount = groupIds.length > 0 ? await myClient.getAccount(account.userName ?? input.identity) : account
            res.send(toAccountOutput(freshAccount))
            logger.info(`stdAccountCreate created account: ${account.userName}`)
        })
        .stdAccountEnable(async (context: Context, input: StdAccountEnableInput, res: Response<StdAccountEnableOutput>) => {
            const account = await myClient.enableAccount(input.identity)

            res.send(toAccountOutput(account))
            logger.info(`stdAccountEnable enabled account: ${input.identity}`)
        })
        .stdAccountDisable(async (context: Context, input: StdAccountDisableInput, res: Response<StdAccountDisableOutput>) => {
            const account = await myClient.disableAccount(input.identity)

            res.send(toAccountOutput(account))
            logger.info(`stdAccountDisable disabled account: ${input.identity}`)
        })
        .stdEntitlementList(async (context: Context, input: StdEntitlementListInput, res: Response<StdEntitlementListOutput>) => {
            const groups = await myClient.getAllGroups()

            for (const group of groups) {
                res.send(toEntitlementOutput(group))
            }
            logger.info(`stdEntitlementList sent ${groups.length} groups`)
        })
        .stdAccountUpdate(async (context: Context, input: StdAccountUpdateInput, res: Response<StdAccountUpdateOutput>) => {
            const account = await myClient.updateAccount(input.identity, input.changes)

            res.send(toAccountOutput(account))
            logger.info(`stdAccountUpdate updated account: ${input.identity}`)
        })
        .stdAccountDelete(async (context: Context, input: StdAccountDeleteInput, res: Response<StdAccountDeleteOutput>) => {
            await myClient.deleteAccount(input.identity)

            res.send({})
            logger.info(`stdAccountDelete deleted account: ${input.identity}`)
        })
}
