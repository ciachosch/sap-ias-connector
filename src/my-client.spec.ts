import { ConnectorError } from '@sailpoint/connector-sdk'
import axios from 'axios'
import { MyClient } from './my-client'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

// Shared mock for the axios instance returned by axios.create()
const instance = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
}

const validConfig = {
    baseUrl: 'https://example.accounts.ondemand.com/',
    clientId: 'client-id',
    clientSecret: 'client-secret',
}

const makeClient = () => {
    ;(mockedAxios.create as jest.Mock).mockReturnValue(instance as any)
    // Token endpoint (axios.post called directly, not via instance)
    ;(mockedAxios.post as jest.Mock).mockResolvedValue({
        data: { access_token: 'tok', expires_in: 3600 },
    })
    return new MyClient(validConfig)
}

describe('MyClient construction', () => {
    it('throws when baseUrl is missing', () => {
        expect(() => new MyClient({ clientId: 'a', clientSecret: 'b' })).toThrow(ConnectorError)
    })
    it('throws when clientId is missing', () => {
        expect(() => new MyClient({ baseUrl: 'x', clientSecret: 'b' })).toThrow(ConnectorError)
    })
    it('throws when clientSecret is missing', () => {
        expect(() => new MyClient({ baseUrl: 'x', clientId: 'a' })).toThrow(ConnectorError)
    })
    it('strips trailing slashes from baseUrl', () => {
        makeClient()
        // create() called with normalized baseURL (no trailing slash)
        const createArg = (mockedAxios.create as jest.Mock).mock.calls[0][0]
        expect(createArg.baseURL).toBe('https://example.accounts.ondemand.com')
    })
})

describe('getAllAccounts', () => {
    it('paginates and filters out users without userName', async () => {
        const client = makeClient()
        instance.get
            .mockResolvedValueOnce({
                data: { Resources: [{ userName: 'a' }, { id: 'no-username' }], totalResults: 3 },
            })
            .mockResolvedValueOnce({
                data: { Resources: [{ userName: 'b' }], totalResults: 3 },
            })
        const accounts = await client.getAllAccounts()
        expect(accounts.map((a) => a.userName)).toEqual(['a', 'b'])
        expect(instance.get).toHaveBeenCalledTimes(2)
    })
})

describe('streamAccounts', () => {
    it('streams each page to the callback, filters userName-less entries, returns count', async () => {
        const client = makeClient()
        instance.get
            .mockResolvedValueOnce({ data: { Resources: [{ userName: 'a' }, { id: 'x' }], totalResults: 3 } })
            .mockResolvedValueOnce({ data: { Resources: [{ userName: 'b' }], totalResults: 3 } })
        const batches: any[][] = []
        const sent = await client.streamAccounts((b) => {
            batches.push(b)
        })
        expect(batches).toEqual([[{ userName: 'a' }], [{ userName: 'b' }]])
        expect(sent).toBe(2)
        expect(instance.get).toHaveBeenCalledTimes(2)
    })
})

describe('getAccount', () => {
    it('escapes double quotes in the SCIM filter', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd"x', id: '1' }] } })
        await client.getAccount('jd"x')
        const params = instance.get.mock.calls[0][1].params
        expect(params.filter).toBe('userName eq "jd\\"x"')
    })
    it('throws ConnectorError when account not found', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [] } })
        await expect(client.getAccount('ghost')).rejects.toThrow(ConnectorError)
    })
})

describe('updateAccount entitlement provisioning', () => {
    it('routes a group Add to PATCH /scim/Groups with add members op', async () => {
        const client = makeClient()
        // getAccount lookups (initial + final re-read)
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'user-1' }] } })
        instance.patch.mockResolvedValue({ data: {} })

        await client.updateAccount('jd', [{ op: 'Add', attribute: 'groups', value: 'group-99' }])

        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Groups/group-99',
            expect.objectContaining({
                Operations: [{ op: 'add', path: 'members', value: [{ value: 'user-1' }] }],
            })
        )
    })

    it('adds each group individually when a single Add change carries an array of group ids', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'user-1' }] } })
        instance.patch.mockResolvedValue({ data: {} })

        await client.updateAccount('jd', [{ op: 'Add', attribute: 'groups', value: ['group-a', 'group-b'] }])

        // must be one PATCH per group, never a comma-joined "/scim/Groups/group-a,group-b"
        expect(instance.patch).toHaveBeenCalledWith('/scim/Groups/group-a', expect.anything())
        expect(instance.patch).toHaveBeenCalledWith('/scim/Groups/group-b', expect.anything())
        expect(instance.patch).not.toHaveBeenCalledWith(
            expect.stringContaining(','),
            expect.anything()
        )
    })

    it('routes a group Remove to PATCH /scim/Groups with remove members op', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'user-1' }] } })
        instance.patch.mockResolvedValue({ data: {} })

        await client.updateAccount('jd', [{ op: 'Remove', attribute: 'groups', value: 'group-99' }])

        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Groups/group-99',
            expect.objectContaining({
                Operations: [{ op: 'remove', path: 'members[value eq "user-1"]' }],
            })
        )
    })

    it('routes a plain attribute change to PATCH /scim/Users', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'user-1' }] } })
        instance.patch.mockResolvedValue({ data: {} })

        await client.updateAccount('jd', [{ op: 'Replace', attribute: 'givenName', value: 'Jane' }])

        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Users/user-1',
            expect.objectContaining({
                Operations: [{ op: 'replace', path: 'name.givenName', value: 'Jane' }],
            })
        )
    })

    it('patches a carisma attribute via its full schema-prefixed path', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'user-1' }] } })
        instance.patch.mockResolvedValue({ data: {} })

        await client.updateAccount('jd', [{ op: 'Replace', attribute: 'companyCode', value: 'H040' }])

        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Users/user-1',
            expect.objectContaining({
                Operations: [
                    {
                        op: 'replace',
                        path: 'urn:pag:cloud:scim:schemas:extension:carisma:2.0:User:companyCode',
                        value: 'H040',
                    },
                ],
            })
        )
    })
})

describe('modifyGroupMembership', () => {
    it('adds a member', async () => {
        const client = makeClient()
        instance.patch.mockResolvedValue({ data: {} })
        await client.modifyGroupMembership('g1', 'u1', 'add')
        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Groups/g1',
            expect.objectContaining({
                Operations: [{ op: 'add', path: 'members', value: [{ value: 'u1' }] }],
            })
        )
    })
    it('wraps API errors in ConnectorError', async () => {
        const client = makeClient()
        instance.patch.mockRejectedValue({ response: { status: 404, data: { detail: 'nope' } } })
        await expect(client.modifyGroupMembership('g1', 'u1', 'add')).rejects.toThrow(ConnectorError)
    })
})

describe('deleteAccount', () => {
    it('looks up the user then issues DELETE by id', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'user-7' }] } })
        instance.delete.mockResolvedValue({ data: {} })
        await client.deleteAccount('jd')
        expect(instance.delete).toHaveBeenCalledWith('/scim/Users/user-7')
    })
})

describe('createAccount', () => {
    it('posts a SCIM user with userName falling back to identity', async () => {
        const client = makeClient()
        instance.post.mockResolvedValue({ data: { id: 'new', userName: 'jd' } })
        await client.createAccount({ identity: 'jd', givenName: 'J', familyName: 'D', email: 'j@x.com' })
        const [url, payload] = instance.post.mock.calls[0]
        expect(url).toBe('/scim/Users')
        expect(payload.userName).toBe('jd')
        expect(payload.active).toBeUndefined()
        expect(payload.name).toEqual({ givenName: 'J', familyName: 'D' })
    })

    it('writes carisma + custom extension fields on create', async () => {
        const client = makeClient()
        instance.post.mockResolvedValue({ data: { id: 'new', userName: 'jd' } })
        await client.createAccount({ userName: 'jd', companyCode: 'H040', manager: 'MGR-9' })
        const payload = instance.post.mock.calls[0][1]
        expect(payload['urn:pag:cloud:scim:schemas:extension:carisma:2.0:User'].companyCode).toBe('H040')
        expect(payload['urn:sap:cloud:scim:schemas:extension:custom:2.0:User'].attributes).toEqual([{ name: 'customAttribute7', value: 'MGR-9' }])
    })
})

describe('enable/disable', () => {
    it('enable PATCHes active=true then re-reads', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'u1' }] } })
        instance.patch.mockResolvedValue({ data: {} })
        await client.enableAccount('jd')
        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Users/u1',
            expect.objectContaining({ Operations: [{ op: 'replace', path: 'active', value: true }] })
        )
    })
    it('disable PATCHes active=false', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: { Resources: [{ userName: 'jd', id: 'u1' }] } })
        instance.patch.mockResolvedValue({ data: {} })
        await client.disableAccount('jd')
        expect(instance.patch).toHaveBeenCalledWith(
            '/scim/Users/u1',
            expect.objectContaining({ Operations: [{ op: 'replace', path: 'active', value: false }] })
        )
    })
})

describe('getAllGroups', () => {
    it('paginates over /scim/Groups', async () => {
        const client = makeClient()
        instance.get
            .mockResolvedValueOnce({ data: { Resources: [{ id: 'g1' }], totalResults: 2 } })
            .mockResolvedValueOnce({ data: { Resources: [{ id: 'g2' }], totalResults: 2 } })
        const groups = await client.getAllGroups()
        expect(groups.map((g) => g.id)).toEqual(['g1', 'g2'])
        expect(instance.get).toHaveBeenCalledWith('/scim/Groups', expect.anything())
    })
})

describe('testConnection', () => {
    it('returns empty object on success', async () => {
        const client = makeClient()
        instance.get.mockResolvedValue({ data: {} })
        expect(await client.testConnection()).toEqual({})
    })
    it('throws ConnectorError on failure', async () => {
        const client = makeClient()
        instance.get.mockRejectedValue({ response: { status: 401, data: { error: 'unauthorized' } } })
        await expect(client.testConnection()).rejects.toThrow(ConnectorError)
    })
})
