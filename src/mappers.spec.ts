import { toAccountOutput, toEntitlementOutput } from './index'

const SAP_EXT = 'urn:ietf:params:scim:schemas:extension:sap:2.0:User'
const ENT_EXT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
const CUSTOM_EXT = 'urn:sap:cloud:scim:schemas:extension:custom:2.0:User'
const CARISMA_EXT = 'urn:pag:cloud:scim:schemas:extension:carisma:2.0:User'
const GRP_CUSTOM = 'urn:sap:cloud:scim:schemas:extension:custom:2.0:Group'
const GRP_SAP = 'urn:ietf:params:scim:schemas:extension:sap:2.0:Group'

describe('toAccountOutput', () => {
    const scimUser = {
        id: 'uuid-1',
        userName: 'john.doe',
        active: true,
        name: { givenName: 'John', familyName: 'Doe' },
        emails: [
            { value: 'john@x.com', type: 'work', primary: true, verified: true },
            { value: 'john.private@gmail.com', type: 'other', primary: false },
        ],
        displayName: 'John Doe',
        groups: [
            { value: 'g-uuid-1', display: 'Admins' },
            { value: 'g-uuid-2', display: 'Standard User' },
        ],
        [SAP_EXT]: { userId: 'P000001', userUuid: 'sap-uuid', loginName: 'jdoe' },
        [ENT_EXT]: { costCenter: 'CC1', organization: 'Porsche AG' },
        [CUSTOM_EXT]: { customAttribute7: 'MGR-123' },
        [CARISMA_EXT]: {
            vwgPersonStatus: '1',
            companyCode: 'H040',
            mgmtLevel: 'M',
            vwgResponsible: 'resp-user',
            ntprimaryUserAccount: 'jdoe-ad',
            CisoLiso: 'Y',
            vwgCommunity: 'Internal',
        },
    }

    it('exposes userName and id as attributes for ISC correlation', () => {
        expect(toAccountOutput(scimUser).attributes.userName).toBe('john.doe')
        expect(toAccountOutput(scimUser).attributes.id).toBe('uuid-1')
    })

    it('maps groups to their UUID (value), not the display name', () => {
        // This is the regression that broke entitlement correlation
        expect(toAccountOutput(scimUser).attributes.groups).toEqual(['g-uuid-1', 'g-uuid-2'])
    })

    it('derives locked as the inverse of active', () => {
        expect(toAccountOutput(scimUser).attributes.locked).toBe(false)
        expect(toAccountOutput({ ...scimUser, active: false }).attributes.locked).toBe(true)
    })

    it('sets identity to userName and uuid to the SCIM id', () => {
        const out = toAccountOutput(scimUser)
        expect(out.identity).toBe('john.doe')
        expect(out.uuid).toBe('uuid-1')
    })

    it('falls back to id when userName is missing', () => {
        const out = toAccountOutput({ id: 'x' })
        expect(out.identity).toBe('x')
        expect(out.attributes.userName).toBe('x')
    })

    it('falls back to id when userName is empty string', () => {
        const out = toAccountOutput({ id: 'y', userName: '' })
        expect(out.identity).toBe('y')
        expect(out.attributes.userName).toBe('y')
    })

    it('throws when both userName and id are missing', () => {
        expect(() => toAccountOutput({})).toThrow()
    })

    it('handles a user with no groups as an empty array', () => {
        const out = toAccountOutput({ userName: 'x', id: '1', active: true })
        expect(out.attributes.groups).toEqual([])
    })

    it('reads manager from the custom extension customAttribute7, not enterprise', () => {
        expect(toAccountOutput(scimUser).attributes.manager).toBe('MGR-123')
    })

    it('reads manager from the array-format custom extension', () => {
        const user = {
            ...scimUser,
            [CUSTOM_EXT]: { attributes: [{ name: 'customAttribute7', value: 'MGR-ARRAY' }] },
        }
        expect(toAccountOutput(user).attributes.manager).toBe('MGR-ARRAY')
    })

    it('reads organization (corp) from the enterprise extension', () => {
        expect(toAccountOutput(scimUser).attributes.organization).toBe('Porsche AG')
    })

    it('reads primary and external email separately', () => {
        const a = toAccountOutput(scimUser).attributes
        expect(a.email).toBe('john@x.com')
        expect(a.externalEmail).toBe('john.private@gmail.com')
    })

    it('reads PAG carisma extension attributes', () => {
        const a = toAccountOutput(scimUser).attributes
        expect(a.vwgPersonenStatus).toBe('1')
        expect(a.companyCode).toBe('H040')
        expect(a.mgmtLevel).toBe('M')
        expect(a.vwgResponsible).toBe('resp-user')
        expect(a.ntprimaryUserAccount).toBe('jdoe-ad')
        expect(a.cisoLiso).toBe('Y')
        expect(a.vwgCommunity).toBe('Internal')
    })

    it('leaves carisma attributes undefined when the extension is absent', () => {
        const out = toAccountOutput({ userName: 'x', id: '1', active: true })
        expect(out.attributes.companyCode).toBeUndefined()
        expect(out.attributes.manager).toBeNull()
    })
})

describe('toEntitlementOutput', () => {
    const scimGroup = {
        id: 'g-uuid-1',
        displayName: 'Admins',
        [GRP_CUSTOM]: { name: 'admins', description: 'Admin group' },
        [GRP_SAP]: { type: 'userGroup', applicationId: 'app-1' },
    }

    it('uses the group UUID as identity (matches account groups values)', () => {
        const out = toEntitlementOutput(scimGroup)
        expect(out.identity).toBe('g-uuid-1')
        expect(out.uuid).toBe('g-uuid-1')
    })

    it('exposes displayName so ISC shows the name, not the GUID', () => {
        expect(toEntitlementOutput(scimGroup).attributes.displayName).toBe('Admins')
    })

    it('maps SAP custom and sap extension attributes', () => {
        const a = toEntitlementOutput(scimGroup).attributes
        expect(a.name).toBe('admins')
        expect(a.type).toBe('userGroup')
        expect(a.applicationId).toBe('app-1')
    })
})
