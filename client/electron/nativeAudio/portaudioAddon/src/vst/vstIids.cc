// VST3 interface IID definitions for the KGB host (E1 / V1).
//
// The Steinberg SDK declares interface iids in headers (DECLARE_CLASS_IID) but
// each must be *defined* exactly once in a TU via DEF_CLASS_IID. The shipped
// iid files (pluginterfaces/base/coreiids.cpp, public.sdk/.../commoniids.cpp)
// cover only the base + GUI interfaces. The VST-domain interfaces a host needs
// are defined here — same explicit pattern as coreiids.cpp, partitioned so no
// symbol is defined twice. Compiled only when KGB_WITH_VST=1.
#ifdef KGB_WITH_VST

#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstpluginterfacesupport.h"

namespace Steinberg {
namespace Vst {

DEF_CLASS_IID (IComponent)
DEF_CLASS_IID (IAudioProcessor)
DEF_CLASS_IID (IEditController)
DEF_CLASS_IID (IEditController2)
DEF_CLASS_IID (IMidiMapping)
DEF_CLASS_IID (IConnectionPoint)
DEF_CLASS_IID (IMessage)
DEF_CLASS_IID (IAttributeList)
DEF_CLASS_IID (IUnitInfo)
DEF_CLASS_IID (IUnitData)
DEF_CLASS_IID (IProgramListData)
DEF_CLASS_IID (IEventList)
DEF_CLASS_IID (IParameterChanges)
DEF_CLASS_IID (IParamValueQueue)
DEF_CLASS_IID (IHostApplication)
DEF_CLASS_IID (IPlugInterfaceSupport)

}  // namespace Vst
}  // namespace Steinberg

#endif  // KGB_WITH_VST
