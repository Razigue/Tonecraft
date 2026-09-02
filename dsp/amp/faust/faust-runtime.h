// The minimum the Faust-generated class needs to compile.
//
// Faust's own architecture headers would bring a dependency, a licence to
// track and a pile of virtual machinery for a UI this product does not use —
// its controls come from schema/params.ts and are written straight into the
// generated object's public fields. So these are the three types the generated
// code names, and nothing else.
//
// Nothing here is ever called on the audio path. `buildUserInterface` exists
// so the generated file compiles; it is never invoked.

#pragma once

#ifndef FAUSTFLOAT
#define FAUSTFLOAT float
#endif

namespace tonecraft {

struct Meta {
  virtual ~Meta() = default;
  virtual void declare(const char*, const char*) {}
};

struct UI {
  virtual ~UI() = default;
  virtual void openVerticalBox(const char*) {}
  virtual void openHorizontalBox(const char*) {}
  virtual void closeBox() {}
  virtual void addHorizontalSlider(const char*, FAUSTFLOAT*, FAUSTFLOAT, FAUSTFLOAT,
                                   FAUSTFLOAT, FAUSTFLOAT) {}
  virtual void addVerticalSlider(const char*, FAUSTFLOAT*, FAUSTFLOAT, FAUSTFLOAT,
                                 FAUSTFLOAT, FAUSTFLOAT) {}
  virtual void addNumEntry(const char*, FAUSTFLOAT*, FAUSTFLOAT, FAUSTFLOAT,
                           FAUSTFLOAT, FAUSTFLOAT) {}
};

struct dsp {
  virtual ~dsp() = default;
  virtual int getNumInputs() = 0;
  virtual int getNumOutputs() = 0;
  virtual void buildUserInterface(UI* ui) = 0;
  virtual void init(int sampleRate) = 0;
  virtual void instanceInit(int sampleRate) = 0;
  virtual void instanceConstants(int sampleRate) = 0;
  virtual void instanceResetUserInterface() = 0;
  virtual void instanceClear() = 0;
  virtual int getSampleRate() = 0;
  virtual dsp* clone() = 0;
  virtual void compute(int count, FAUSTFLOAT** inputs, FAUSTFLOAT** outputs) = 0;
};

}  // namespace tonecraft
