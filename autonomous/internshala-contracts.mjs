// Contracts cover only original forms actually observed. Adding a preparation
// contract never certifies its live dispatch. Historical ARH identifiers stay
// unchanged so existing sealed receipts remain independently recoverable.
export const ARH_NATIVE_CONTRACT='arh-easy-apply-v1';
export const ARH_NATIVE_SLUG='work-from-home-general-management-internship-at-arh-tubes-and-profiles-pvt-ltd1792564453';
export const AXE_NATIVE_CONTRACT='axe-market-research-easy-apply-v1';
export const AXE_NATIVE_SLUG='work-from-home-market-research-internship-at-axe-consultancy-and-security-services-llc1791797570';
export const SANKAR_NATIVE_CONTRACT='sankar-project-management-easy-apply-v1';
export const SANKAR_NATIVE_SLUG='work-from-home-project-management-internship-at-sankar-group1792246444';
export const HUMANHIRE_NATIVE_CONTRACT='humanhire-global-client-strategist-easy-apply-v1';
export const HUMANHIRE_NATIVE_SLUG='work-from-home-global-client-strategist-internship-at-humanhire-corp1792557819';
const yesNo=Object.freeze(['Yes','No'].map(value=>Object.freeze({value,label:value,disabled:false})));
const radio=(name,label,primaryKey)=>Object.freeze({name,label,tag:'input',type:'radio',required:true,answerKind:'primary-boolean',primaryKey,mapping:'primary-boolean-yes-no-v1',options:yesNo});
const rating=Object.freeze({name:'custom_question_range_11',label:'How would you rate your proficiency in Project Management, on a scale of 1 - 5?',tag:'select',type:'select-one',required:true,answerKind:'primary-rating',mapping:'primary-rating-1-to-5-v1',options:Object.freeze([Object.freeze({value:'',label:'Select Range',disabled:true}),...['1','2','3','4','5'].map(value=>Object.freeze({value,label:value,disabled:false}))])});
const question=(name,label,answerKind)=>Object.freeze({name,label,tag:'textarea',type:'textarea',required:true,answerKind});
export const INTERNSHALA_NATIVE_CONTRACTS=Object.freeze([
  Object.freeze({id:ARH_NATIVE_CONTRACT,slug:ARH_NATIVE_SLUG,role:'General Management',liveValidated:true,questions:Object.freeze([])}),
  Object.freeze({id:AXE_NATIVE_CONTRACT,slug:AXE_NATIVE_SLUG,company:'Axe Consultancy And Security Services LLC',role:'Market Research',liveValidated:true,questions:Object.freeze([
    question('custom_question_text_7464862','Which tools are you familiar with for collecting and analyzing market data?','tool-familiarity'),
    question('custom_question_text_12','Please share a link to your portfolio/work samples for Market Research.','general-portfolio-url'),
  ])}),
  Object.freeze({id:SANKAR_NATIVE_CONTRACT,slug:SANKAR_NATIVE_SLUG,company:'Sankar Group',role:'Project Management',liveValidated:true,questions:Object.freeze([radio('custom_question_radio_2','Do you have a working laptop and internet?','working_laptop_and_reliable_internet'),rating])}),
  Object.freeze({id:HUMANHIRE_NATIVE_CONTRACT,slug:HUMANHIRE_NATIVE_SLUG,company:'HumanHire Corp',role:'Global Client Strategist',liveValidated:true,questions:Object.freeze([radio('custom_question_radio_8','Are you comfortable with night shifts?','comfortable_working_night_shifts')])}),
]);
export function internshalaNativeContract(sourceUrl) {
  return INTERNSHALA_NATIVE_CONTRACTS.find(contract=>sourceUrl===`https://internshala.com/internship/detail/${contract.slug}`) ?? null;
}
export function nativeQuestionSchema(contract) {
  return contract.questions.map(({name,label,tag,type,required,options,mapping})=>({name,label,tag,type,required,...(options?{options,mapping}:{})}));
}
