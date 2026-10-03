export const when='2026-01-01T00:00:00.000Z';
export function minimalBackup(value=null) {
 const id='11111111-1111-4111-8111-111111111111';
 return {format:'jsonbin-backup',schemaVersion:1,appVersion:'3.0.0',exportedAt:when,scope:{kind:'all'},settings:{defaultVisibility:'private',defaultTtlSeconds:null},collections:[],schemas:[],purged:[],bins:[{meta:{id,name:'中文',description:'',visibility:'private',collectionId:null,schemaId:null,schemaRevision:null,currentVersion:1,size:new TextEncoder().encode(JSON.stringify(value)).length,locked:false,schemaLocked:false,createdAt:when,updatedAt:when,expiresAt:null},versions:[{version:1,uploadedAt:when,value}]}]};
}
export function richBackup() {
 const p=minimalBackup(false),collectionId='22222222-2222-4222-8222-222222222222',schemaId='33333333-3333-4333-8333-333333333333';
 p.collections.push({meta:{id:collectionId,name:'集合',description:'',slug:'collection-'+collectionId,status:'active',createdAt:when,updatedAt:when}});
 p.schemas.push({meta:{id:schemaId,name:'布尔',description:'',status:'deleted',currentRevision:3,createdAt:when,updatedAt:when},revisions:[{revision:1,uploadedAt:when,schema:{type:'boolean'}},{revision:3,uploadedAt:when,schema:{type:'string'}}]});
 Object.assign(p.bins[0].meta,{collectionId,schemaId,schemaRevision:1,locked:true,schemaLocked:true});
 p.bins[0].versions.push({version:4,uploadedAt:when,value:'old orphan'});
 p.purged.push({id:'44444444-4444-4444-8444-444444444444',deletedAt:when}); return p;
}
