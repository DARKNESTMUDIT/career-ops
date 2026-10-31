// Contracts cover only original forms actually observed. Adding a preparation
// contract never certifies its live dispatch. Historical ARH identifiers stay
// unchanged so existing sealed receipts remain independently recoverable.
export const ARH_NATIVE_CONTRACT='arh-easy-apply-v1';
export const ARH_NATIVE_SLUG='work-from-home-general-management-internship-at-arh-tubes-and-profiles-pvt-ltd1792564453';
export const AXE_NATIVE_CONTRACT='axe-market-research-easy-apply-v1';
export const AXE_NATIVE_SLUG='work-from-home-market-research-internship-at-axe-consultancy-and-security-services-llc1791797570';
const question=(name,label,answerKind)=>Object.freeze({name,label,tag:'textarea',type:'textarea',required:true,answerKind});
export const INTERNSHALA_NATIVE_CONTRACTS=Object.freeze([
  Object.freeze({id:ARH_NATIVE_CONTRACT,slug:ARH_NATIVE_SLUG,role:'General Management',liveValidated:true,questions:Object.freeze([])}),
  Object.freeze({id:AXE_NATIVE_CONTRACT,slug:AXE_NATIVE_SLUG,company:'Axe Consultancy And Security Services LLC',role:'Market Research',liveValidated:true,questions:Object.freeze([
    question('custom_question_text_7464862','Which tools are you familiar with for collecting and analyzing market data?','tool-familiarity'),
    question('custom_question_text_12','Please share a link to your portfolio/work samples for Market Research.','general-portfolio-url'),
  ])}),
]);
export function internshalaNativeContract(sourceUrl) {
  return INTERNSHALA_NATIVE_CONTRACTS.find(contract=>sourceUrl===`https://internshala.com/internship/detail/${contract.slug}`) ?? null;
}
export function nativeQuestionSchema(contract) {
  return contract.questions.map(({name,label,tag,type,required})=>({name,label,tag,type,required}));
}
