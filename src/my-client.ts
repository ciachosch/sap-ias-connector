import axios, { AxiosInstance } from 'axios'
import { ConnectorError, logger } from '@sailpoint/connector-sdk'
import { buildScimCreatePayload, attributeToPatch, isValidEmail } from './scim-mapping'

export class MyClient {
    private readonly client: AxiosInstance
    private readonly clientId: string
    private readonly clientSecret: string
    private readonly baseUrl: string
    private readonly pageSize: number
    private accessToken: string | null = null
    private tokenExpiresAt: number = 0

    constructor(config: any) {
        if (!config?.baseUrl) {
            throw new ConnectorError('baseUrl must be provided from config')
        }
        if (!config?.clientId) {
            throw new ConnectorError('clientId must be provided from config')
        }
        if (!config?.clientSecret) {
            throw new ConnectorError('clientSecret must be provided from config')
        }

        this.baseUrl = config.baseUrl.replace(/\/+$/, '') // strip trailing slashes
        this.clientId = config.clientId
        this.clientSecret = config.clientSecret
        // SCIM page size for aggregation. Larger pages = fewer requests = less rate-limit
        // pressure at scale (tens of thousands of accounts). Configurable via source config.
        this.pageSize = Number(config.pageSize) > 0 ? Number(config.pageSize) : 500

        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/scim+json',
                Accept: 'application/scim+json',
            },
            transformResponse: (data) => {
                if (typeof data === 'string') {
                    try { return JSON.parse(data) } catch { return data }
                }
                return data
            },
        })

        this.client.interceptors.request.use(async (reqConfig) => {
            const token = await this.getAccessToken()
            reqConfig.headers.Authorization = `Bearer ${token}`
            return reqConfig
        })

        // Retry transient failures (rate limiting / 5xx / network) with backoff.
        // Critical for large aggregations: without this a single HTTP 429 from SAP IAS
        // aborts the whole run. Honors Retry-After on 429, else exponential backoff.
        const MAX_RETRIES = 5
        this.client.interceptors.response.use(
            (response) => response,
            async (error) => {
                const cfg: any = error.config || {}
                const status: number | undefined = error.response?.status
                const retriable = status === 429 || (status !== undefined && status >= 500) || !error.response
                cfg.__retryCount = cfg.__retryCount || 0
                if (retriable && cfg.__retryCount < MAX_RETRIES) {
                    cfg.__retryCount++
                    const retryAfter = Number(error.response?.headers?.['retry-after'])
                    const waitMs =
                        Number.isFinite(retryAfter) && retryAfter > 0
                            ? retryAfter * 1000
                            : Math.min(1000 * 2 ** (cfg.__retryCount - 1), 30000)
                    logger.warn(
                        `Request ${cfg.url} failed (HTTP ${status ?? 'network'}) — retry ${cfg.__retryCount}/${MAX_RETRIES} in ${waitMs}ms`
                    )
                    await new Promise((resolve) => setTimeout(resolve, waitMs))
                    return this.client(cfg)
                }
                return Promise.reject(error)
            }
        )
    }

    private async getAccessToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiresAt) {
            return this.accessToken
        }

        const params = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.clientId,
            client_secret: this.clientSecret,
        })

        try {
            const response = await axios.post(`${this.baseUrl}/oauth2/token`, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            })

            this.accessToken = response.data.access_token
            // expires_in is in seconds; subtract 30s as safety buffer
            this.tokenExpiresAt = Date.now() + (response.data.expires_in - 30) * 1000

            return this.accessToken!
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Token request failed (HTTP ${status}): ${body}`)
        }
    }

    /**
     * Page through all SCIM users and hand each page to `onBatch` as it arrives.
     * Streaming (instead of buffering everything) keeps memory flat and lets ISC start
     * processing immediately — important for tens of thousands of accounts. Entries
     * without userName are filtered out. Returns the number of accounts sent.
     */
    async streamAccounts(onBatch: (batch: any[]) => Promise<void> | void): Promise<number> {
        let startIndex = 1
        let sent = 0
        let fetched = 0
        try {
            while (true) {
                const response = await this.client.get('/scim/Users', {
                    params: { startIndex, count: this.pageSize },
                })
                const resources: any[] = response.data.Resources ?? []
                const valid = resources.filter((u) => !!u.userName)
                if (valid.length) {
                    await onBatch(valid)
                    sent += valid.length
                }
                fetched += resources.length

                const totalResults = response.data.totalResults ?? 0
                logger.info(`streamAccounts: fetched ${fetched} / ${totalResults} users`)

                if (resources.length === 0 || fetched >= totalResults) {
                    break
                }
                // advance by the actual page size returned — SAP IAS may cap below pageSize
                startIndex += resources.length
            }
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to list accounts (HTTP ${status}): ${body}`)
        }
        return sent
    }

    /** Buffering convenience wrapper around streamAccounts (kept for callers/tests). */
    async getAllAccounts(): Promise<any[]> {
        const all: any[] = []
        await this.streamAccounts((batch) => {
            all.push(...batch)
        })
        return all
    }

    async getAllGroups(): Promise<any[]> {
        const allResources: any[] = []
        let startIndex = 1
        const count = 100

        try {
            while (true) {
                const response = await this.client.get('/scim/Groups', {
                    params: { startIndex, count },
                })
                const resources: any[] = response.data.Resources ?? []
                allResources.push(...resources)

                const totalResults = response.data.totalResults ?? 0
                logger.info(`getAllGroups: fetched ${allResources.length} / ${totalResults} groups`)

                if (allResources.length >= totalResults || resources.length === 0) {
                    break
                }
                startIndex += count
            }
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to list groups (HTTP ${status}): ${body}`)
        }

        return allResources
    }

    async getAccount(identity: string): Promise<any> {
        try {
            // Escape double quotes to avoid breaking the SCIM filter (basic injection guard)
            const safeIdentity = identity.replace(/"/g, '\\"')
            const response = await this.client.get('/scim/Users', {
                params: { filter: `userName eq "${safeIdentity}"` },
            })
            const resources: any[] = response.data.Resources ?? []
            if (resources.length === 0) {
                throw new ConnectorError(`Account not found: ${identity}`)
            }
            return resources[0]
        } catch (err: any) {
            if (err instanceof ConnectorError) throw err
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to get account '${identity}' (HTTP ${status}): ${body}`)
        }
    }

    async testConnection(): Promise<any> {
        try {
            await this.client.get('/scim/Users', { params: { count: 1 } })
            return {}
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Test connection failed (HTTP ${status}): ${body}`)
        }
    }

    async createAccount(attributes: any): Promise<any> {
        const payload = buildScimCreatePayload(attributes)
        try {
            const response = await this.client.post('/scim/Users', payload)
            let created = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
            if (!created || typeof created !== 'object') created = {}

            // POST response may not contain id — look up by email to find the created user
            if (!created.id && payload.emails?.[0]?.value) {
                const safeEmail = payload.emails[0].value.replace(/"/g, '\\"')
                const lookup = await this.client.get('/scim/Users', {
                    params: { filter: `emails.value eq "${safeEmail}"` },
                })
                const found = (lookup.data?.Resources ?? []) as any[]
                if (found.length > 0) created = found[found.length - 1]
            }

            // SAP IAS may ignore userName on POST — always patch it to be safe
            if (payload.userName && created.id) {
                try {
                    await this.client.patch(`/scim/Users/${created.id}`, {
                        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                        Operations: [{ op: 'replace', path: 'userName', value: payload.userName }],
                    })
                } catch (patchErr: any) {
                    logger.warn(`createAccount: userName PATCH failed (${patchErr.response?.status ?? 'unknown'})`)
                }
                created.userName = payload.userName
            }

            return created
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to create account (HTTP ${status}): ${body}`)
        }
    }

    async enableAccount(identity: string): Promise<any> {
        const user = await this.getAccount(identity)
        try {
            await this.client.patch(`/scim/Users/${user.id}`, {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [{ op: 'replace', path: 'active', value: true }],
            })
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to enable account '${identity}' (HTTP ${status}): ${body}`)
        }
        return this.getAccount(identity)
    }

    async disableAccount(identity: string): Promise<any> {
        const user = await this.getAccount(identity)
        try {
            await this.client.patch(`/scim/Users/${user.id}`, {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [{ op: 'replace', path: 'active', value: false }],
            })
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to disable account '${identity}' (HTTP ${status}): ${body}`)
        }
        return this.getAccount(identity)
    }

    /**
     * Add or remove a user from a group. SAP IAS manages group membership on the
     * Group resource, so we PATCH /scim/Groups/{groupId} rather than the User.
     * @param op 'add' | 'remove'
     */
    async modifyGroupMembership(groupId: string, userId: string, op: 'add' | 'remove'): Promise<void> {
        const patchOp =
            op === 'add'
                ? { op: 'add', path: 'members', value: [{ value: userId }] }
                : { op: 'remove', path: `members[value eq "${userId}"]` }
        try {
            await this.client.patch(`/scim/Groups/${groupId}`, {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [patchOp],
            })
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(
                `Failed to ${op} user '${userId}' ${op === 'add' ? 'to' : 'from'} group '${groupId}' (HTTP ${status}): ${body}`
            )
        }
    }

    async updateAccount(identity: string, changes: any[]): Promise<any> {
        const user = await this.getAccount(identity)

        const operations: any[] = []
        const groupChanges: { groupId: string; op: 'add' | 'remove' }[] = []

        for (const change of changes) {
            // Entitlement (group) changes are provisioned on the Group resource, not the User.
            // ISC may deliver multiple group values in a single change as an array — normalize
            // so each group is patched individually (otherwise the array stringifies to
            // "id1,id2" in the /scim/Groups/{id} URL and SAP IAS returns 404).
            if (change.attribute === 'groups') {
                const values = Array.isArray(change.value) ? change.value : [change.value]
                if (change.op === 'Add') {
                    for (const groupId of values) groupChanges.push({ groupId, op: 'add' })
                } else if (change.op === 'Remove') {
                    for (const groupId of values) groupChanges.push({ groupId, op: 'remove' })
                } else {
                    logger.warn(`updateAccount: unsupported op '${change.op}' for groups — skipping`)
                }
                continue
            }

            const mapped = attributeToPatch(change.attribute)
            if (!mapped) {
                logger.warn(`updateAccount: no SCIM mapping for attribute '${change.attribute}' — skipping`)
                continue
            }
            const value = mapped.transform ? mapped.transform(change.value) : change.value
            // Never PATCH a non-email string (e.g. VCD "(none)") — IAS 400s the whole update.
            if ((change.attribute === 'email' || change.attribute === 'externalEmail') &&
                change.op !== 'Remove' && !isValidEmail(value)) {
                logger.warn(`updateAccount: skipping invalid ${change.attribute} value '${value}'`)
                continue
            }
            if (mapped.buildOp) {
                operations.push(mapped.buildOp(value))
            } else if (change.op === 'Remove') {
                operations.push({ op: 'remove', path: mapped.path })
            } else {
                operations.push({ op: 'replace', path: mapped.path, value })
            }
        }

        if (operations.length > 0) {
            try {
                await this.client.patch(`/scim/Users/${user.id}`, {
                    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                    Operations: operations,
                })
            } catch (err: any) {
                const status = err.response?.status ?? 'unknown'
                const body = JSON.stringify(err.response?.data ?? err.message)
                throw new ConnectorError(`Failed to update account '${identity}' (HTTP ${status}): ${body}`)
            }
        }

        for (const gc of groupChanges) {
            await this.modifyGroupMembership(gc.groupId, user.id, gc.op)
        }

        return this.getAccount(identity)
    }

    async deleteAccount(identity: string): Promise<void> {
        const user = await this.getAccount(identity)
        try {
            await this.client.delete(`/scim/Users/${user.id}`)
        } catch (err: any) {
            const status = err.response?.status ?? 'unknown'
            const body = JSON.stringify(err.response?.data ?? err.message)
            throw new ConnectorError(`Failed to delete account '${identity}' (HTTP ${status}): ${body}`)
        }
    }
}
